import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type {
  DirtyDay,
  SlackChannel,
  SlackChannelType,
  SlackMessage,
  SlackUser,
  StoredChannel,
  StoredMessage,
  StoredUser,
} from "./types";

const SCHEMA_VERSION = "1";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  real_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  slack_name TEXT NOT NULL,
  folder_name TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT '',
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_user_deleted INTEGER NOT NULL DEFAULT 0,
  dm_user_id TEXT,
  fully_synced INTEGER NOT NULL DEFAULT 0,
  last_message_ts TEXT,
  last_synced_at INTEGER,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  day_utc TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  subtype TEXT,
  text TEXT NOT NULL DEFAULT '',
  reply_count INTEGER NOT NULL DEFAULT 0,
  latest_reply TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (channel_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_day
  ON messages (channel_id, day_utc, ts);

CREATE INDEX IF NOT EXISTS idx_messages_channel_thread
  ON messages (channel_id, thread_ts, ts);

CREATE TABLE IF NOT EXISTS dirty_days (
  channel_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  PRIMARY KEY (channel_id, day_utc)
);
`;

export interface ThreadSyncState {
  replyCount: number;
  latestReply: string | null;
  storedReplyCount: number;
}

export interface UpsertMessagesResult {
  upserted: number;
  dirtyDays: string[];
}

export interface ChannelSyncStateUpdate {
  lastMessageTs?: string | null;
  lastSyncedAt: number;
  fullySynced?: boolean;
}

interface UserRow {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  is_bot: number;
  deleted: number;
  raw_json: string;
  updated_at: number;
}

interface ChannelRow {
  id: string;
  type: string;
  slack_name: string;
  folder_name: string;
  purpose: string;
  is_archived: number;
  is_user_deleted: number;
  dm_user_id: string | null;
  fully_synced: number;
  last_message_ts: string | null;
  last_synced_at: number | null;
  raw_json: string;
}

interface MessageRow {
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  day_utc: string;
  user_id: string | null;
  username: string | null;
  subtype: string | null;
  text: string;
  reply_count: number;
  latest_reply: string | null;
  raw_json: string;
}

interface ExistingMessageComparisonRow {
  thread_ts: string | null;
  day_utc: string;
  user_id: string | null;
  username: string | null;
  subtype: string | null;
  text: string;
  raw_json: string;
}

interface DirtyDayRow {
  channel_id: string;
  day_utc: string;
}

export class ArchiveStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    this.setMeta("schema_version", SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM meta WHERE key = ?",
      )
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  upsertUsers(users: readonly SlackUser[], nowMs = Date.now()): number {
    if (users.length === 0) {
      return 0;
    }

    const stmt = this.db.query(`
      INSERT INTO users (id, name, real_name, display_name, is_bot, deleted, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        real_name = excluded.real_name,
        display_name = excluded.display_name,
        is_bot = excluded.is_bot,
        deleted = excluded.deleted,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);

    return this.transaction(() => {
      let count = 0;
      for (const user of users) {
        if (!user.id) {
          continue;
        }
        const name = user.name ?? "";
        const realName = user.real_name ?? user.profile?.real_name ?? "";
        const displayName = user.profile?.display_name ?? "";
        stmt.run(
          user.id,
          name,
          realName,
          displayName,
          user.is_bot ? 1 : 0,
          user.deleted ? 1 : 0,
          JSON.stringify(user),
          nowMs,
        );
        count += 1;
      }
      return count;
    });
  }

  hasUser(userId: string): boolean {
    const row = this.db
      .query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?")
      .get(userId);
    return row !== null;
  }

  getUserMap(): Map<string, StoredUser> {
    const rows = this.db.query<UserRow, []>("SELECT * FROM users").all();
    const map = new Map<string, StoredUser>();
    for (const row of rows) {
      map.set(row.id, mapUserRow(row));
    }
    return map;
  }

  upsertChannel(
    channel: SlackChannel,
    channelType: SlackChannelType,
    preferredFolderName: string,
  ): StoredChannel {
    const existing = this.getChannel(channel.id);
    const slackName = channel.name ?? "";
    const purpose = channel.purpose?.value ?? "";
    const isArchived = channel.is_archived ? 1 : 0;
    const isUserDeleted = channel.is_user_deleted ? 1 : 0;
    const dmUserId = channel.user ?? null;
    const rawJson = JSON.stringify(channel);

    if (existing) {
      this.db
        .query(`
          UPDATE channels
          SET type = ?,
              slack_name = ?,
              purpose = ?,
              is_archived = ?,
              is_user_deleted = ?,
              dm_user_id = ?,
              raw_json = ?
          WHERE id = ?
        `)
        .run(
          channelType,
          slackName,
          purpose,
          isArchived,
          isUserDeleted,
          dmUserId,
          rawJson,
          channel.id,
        );
      return this.getChannel(channel.id) as StoredChannel;
    }

    const folderName = this.allocateUniqueFolderName(
      preferredFolderName,
      channel.id,
    );

    this.db
      .query(`
        INSERT INTO channels (
          id, type, slack_name, folder_name, purpose,
          is_archived, is_user_deleted, dm_user_id,
          fully_synced, last_message_ts, last_synced_at, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
      `)
      .run(
        channel.id,
        channelType,
        slackName,
        folderName,
        purpose,
        isArchived,
        isUserDeleted,
        dmUserId,
        rawJson,
      );

    return this.getChannel(channel.id) as StoredChannel;
  }

  getChannel(channelId: string): StoredChannel | null {
    const row = this.db
      .query<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?")
      .get(channelId);
    return row ? mapChannelRow(row) : null;
  }

  getAllChannels(): StoredChannel[] {
    const rows = this.db
      .query<ChannelRow, []>(
        "SELECT * FROM channels ORDER BY LOWER(folder_name), id",
      )
      .all();
    return rows.map(mapChannelRow);
  }

  updateChannelSyncState(
    channelId: string,
    update: ChannelSyncStateUpdate,
  ): void {
    const existing = this.getChannel(channelId);
    if (!existing) {
      return;
    }

    const nextLastMessageTs = pickNewerTs(
      existing.lastMessageTs,
      update.lastMessageTs ?? null,
    );
    const nextFullySynced =
      update.fullySynced !== undefined
        ? update.fullySynced
          ? 1
          : 0
        : existing.fullySynced
          ? 1
          : 0;

    this.db
      .query(`
        UPDATE channels
        SET last_message_ts = ?,
            last_synced_at = ?,
            fully_synced = ?
        WHERE id = ?
      `)
      .run(nextLastMessageTs, update.lastSyncedAt, nextFullySynced, channelId);
  }

  getThreadSyncState(
    channelId: string,
    parentTs: string,
  ): ThreadSyncState | null {
    const parent = this.db
      .query<
        { reply_count: number; latest_reply: string | null },
        [string, string]
      >(
        "SELECT reply_count, latest_reply FROM messages WHERE channel_id = ? AND ts = ?",
      )
      .get(channelId, parentTs);

    if (!parent) {
      return null;
    }

    const countRow = this.db
      .query<{ count: number }, [string, string, string]>(
        "SELECT COUNT(*) AS count FROM messages WHERE channel_id = ? AND thread_ts = ? AND ts != ?",
      )
      .get(channelId, parentTs, parentTs);

    return {
      replyCount: parent.reply_count,
      latestReply: parent.latest_reply,
      storedReplyCount: countRow?.count ?? 0,
    };
  }

  upsertMessages(
    channelId: string,
    messages: readonly SlackMessage[],
  ): UpsertMessagesResult {
    if (messages.length === 0) {
      return { upserted: 0, dirtyDays: [] };
    }

    const selectExisting = this.db.query<
      ExistingMessageComparisonRow,
      [string, string]
    >(
      "SELECT thread_ts, day_utc, user_id, username, subtype, text, raw_json FROM messages WHERE channel_id = ? AND ts = ?",
    );

    const upsertStmt = this.db.query(`
      INSERT INTO messages (
        channel_id, ts, thread_ts, day_utc, user_id, username,
        subtype, text, reply_count, latest_reply, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, ts) DO UPDATE SET
        thread_ts = COALESCE(excluded.thread_ts, messages.thread_ts),
        day_utc = excluded.day_utc,
        user_id = COALESCE(excluded.user_id, messages.user_id),
        username = COALESCE(excluded.username, messages.username),
        subtype = excluded.subtype,
        text = excluded.text,
        reply_count = MAX(messages.reply_count, excluded.reply_count),
        latest_reply = CASE
          WHEN excluded.latest_reply IS NULL THEN messages.latest_reply
          WHEN messages.latest_reply IS NULL THEN excluded.latest_reply
          WHEN CAST(excluded.latest_reply AS REAL) > CAST(messages.latest_reply AS REAL) THEN excluded.latest_reply
          ELSE messages.latest_reply
        END,
        raw_json = excluded.raw_json
    `);

    const insertDirty = this.db.query(
      "INSERT OR IGNORE INTO dirty_days (channel_id, day_utc) VALUES (?, ?)",
    );

    const selectReplyDays = this.db.query<
      { day_utc: string },
      [string, string, string]
    >(
      "SELECT DISTINCT day_utc FROM messages WHERE channel_id = ? AND thread_ts = ? AND ts != ?",
    );

    return this.transaction(() => {
      let upserted = 0;
      const dirtySet = new Set<string>();

      for (const msg of messages) {
        if (!msg.ts) {
          continue;
        }

        const dayUtc = slackTsToUtcDay(msg.ts);
        if (!dayUtc) {
          continue;
        }

        const normalizedMsg = stripNestedReplies(msg);
        const rawJson = JSON.stringify(normalizedMsg);
        const threadTs = normalizedMsg.thread_ts ?? null;
        const userId = normalizedMsg.user ?? null;
        const username = normalizedMsg.username ?? null;
        const subtype = normalizedMsg.subtype ?? null;
        const text = normalizedMsg.text ?? "";
        const replyCount = normalizedMsg.reply_count ?? 0;
        const latestReply = normalizedMsg.latest_reply ?? null;

        const existing = selectExisting.get(channelId, msg.ts);
        const contentChanged =
          existing === null ||
          hasRenderContentChanged(existing, {
            thread_ts: threadTs,
            day_utc: dayUtc,
            user_id: userId,
            username,
            subtype,
            text,
            raw_json: rawJson,
          });

        upsertStmt.run(
          channelId,
          msg.ts,
          threadTs,
          dayUtc,
          userId,
          username,
          subtype,
          text,
          replyCount,
          latestReply,
          rawJson,
        );
        upserted += 1;

        if (contentChanged) {
          dirtySet.add(dayUtc);
          insertDirty.run(channelId, dayUtc);

          // If an existing parent message's text changed, cross-day reply days
          // that quote its snippet should also be re-rendered.
          if (existing !== null && existing.text !== text) {
            const replyDays = selectReplyDays.all(channelId, msg.ts, msg.ts);
            for (const row of replyDays) {
              dirtySet.add(row.day_utc);
              insertDirty.run(channelId, row.day_utc);
            }
          }
        }
      }

      return {
        upserted,
        dirtyDays: Array.from(dirtySet).sort(),
      };
    });
  }

  markDirtyDay(channelId: string, dayUtc: string): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO dirty_days (channel_id, day_utc) VALUES (?, ?)",
      )
      .run(channelId, dayUtc);
  }

  markAllDaysDirty(channelId?: string): number {
    if (channelId) {
      const result = this.db
        .query(`
          INSERT OR IGNORE INTO dirty_days (channel_id, day_utc)
          SELECT DISTINCT channel_id, day_utc FROM messages WHERE channel_id = ?
        `)
        .run(channelId);
      return result.changes;
    }

    const result = this.db
      .query(`
        INSERT OR IGNORE INTO dirty_days (channel_id, day_utc)
        SELECT DISTINCT channel_id, day_utc FROM messages
      `)
      .run();
    return result.changes;
  }

  getDirtyDays(channelId?: string): DirtyDay[] {
    const rows = channelId
      ? this.db
          .query<DirtyDayRow, [string]>(
            "SELECT channel_id, day_utc FROM dirty_days WHERE channel_id = ? ORDER BY day_utc",
          )
          .all(channelId)
      : this.db
          .query<DirtyDayRow, []>(
            "SELECT channel_id, day_utc FROM dirty_days ORDER BY channel_id, day_utc",
          )
          .all();

    return rows.map((row) => ({
      channelId: row.channel_id,
      dayUtc: row.day_utc,
    }));
  }

  clearDirtyDay(channelId: string, dayUtc: string): void {
    this.db
      .query("DELETE FROM dirty_days WHERE channel_id = ? AND day_utc = ?")
      .run(channelId, dayUtc);
  }

  getMessagesForDay(channelId: string, dayUtc: string): StoredMessage[] {
    const rows = this.db
      .query<MessageRow, [string, string]>(
        `SELECT * FROM messages
         WHERE channel_id = ? AND day_utc = ?
         ORDER BY CAST(ts AS REAL) ASC, ts ASC`,
      )
      .all(channelId, dayUtc);
    return rows.map(mapMessageRow);
  }

  getMessagesByTs(
    channelId: string,
    timestamps: readonly string[],
  ): Map<string, StoredMessage> {
    const unique = Array.from(new Set(timestamps));
    const map = new Map<string, StoredMessage>();
    if (unique.length === 0) {
      return map;
    }

    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .query<MessageRow, string[]>(
        `SELECT * FROM messages WHERE channel_id = ? AND ts IN (${placeholders})`,
      )
      .all(channelId, ...unique);

    for (const row of rows) {
      map.set(row.ts, mapMessageRow(row));
    }
    return map;
  }

  getChannelDays(channelId: string): string[] {
    const rows = this.db
      .query<{ day_utc: string }, [string]>(
        "SELECT DISTINCT day_utc FROM messages WHERE channel_id = ? ORDER BY day_utc",
      )
      .all(channelId);
    return rows.map((row) => row.day_utc);
  }

  private allocateUniqueFolderName(
    baseName: string,
    channelId: string,
  ): string {
    const conflict = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM channels WHERE LOWER(folder_name) = LOWER(?)",
      )
      .get(baseName);

    if (!conflict) {
      return baseName;
    }

    const disambiguated = `${baseName} (${channelId})`;
    const secondConflict = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM channels WHERE LOWER(folder_name) = LOWER(?)",
      )
      .get(disambiguated);

    return secondConflict ? channelId : disambiguated;
  }
}

export function slackTsToUtcDay(ts: string): string | null {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function pickNewerTs(
  currentTs: string | null,
  candidateTs: string | null,
): string | null {
  if (!candidateTs) {
    return currentTs;
  }
  if (!currentTs) {
    return candidateTs;
  }
  return Number.parseFloat(candidateTs) > Number.parseFloat(currentTs)
    ? candidateTs
    : currentTs;
}

function mapUserRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    name: row.name,
    realName: row.real_name,
    displayName: row.display_name,
    isBot: row.is_bot === 1,
    deleted: row.deleted === 1,
    rawJson: row.raw_json,
    updatedAt: row.updated_at,
  };
}

function mapChannelRow(row: ChannelRow): StoredChannel {
  return {
    id: row.id,
    type: row.type as SlackChannelType,
    slackName: row.slack_name,
    folderName: row.folder_name,
    purpose: row.purpose,
    isArchived: row.is_archived === 1,
    isUserDeleted: row.is_user_deleted === 1,
    dmUserId: row.dm_user_id,
    fullySynced: row.fully_synced === 1,
    lastMessageTs: row.last_message_ts,
    lastSyncedAt: row.last_synced_at,
    rawJson: row.raw_json,
  };
}

function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    channelId: row.channel_id,
    ts: row.ts,
    threadTs: row.thread_ts,
    dayUtc: row.day_utc,
    userId: row.user_id,
    username: row.username,
    subtype: row.subtype,
    text: row.text,
    replyCount: row.reply_count,
    latestReply: row.latest_reply,
    rawJson: row.raw_json,
  };
}

function stripNestedReplies(msg: SlackMessage): SlackMessage {
  if (msg.replies === undefined) {
    return msg;
  }
  const { replies: _ignored, ...rest } = msg;
  return rest;
}

function hasRenderContentChanged(
  existing: ExistingMessageComparisonRow,
  incoming: ExistingMessageComparisonRow,
): boolean {
  if (
    existing.text !== incoming.text ||
    existing.user_id !== incoming.user_id ||
    existing.username !== incoming.username ||
    existing.subtype !== incoming.subtype ||
    existing.thread_ts !== incoming.thread_ts ||
    existing.day_utc !== incoming.day_utc
  ) {
    return true;
  }

  return (
    extractAttachmentAndFileFingerprint(existing.raw_json) !==
    extractAttachmentAndFileFingerprint(incoming.raw_json)
  );
}

function extractAttachmentAndFileFingerprint(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as SlackMessage;
    return JSON.stringify({
      files: parsed.files ?? null,
      attachments: parsed.attachments ?? null,
    });
  } catch {
    return rawJson;
  }
}
