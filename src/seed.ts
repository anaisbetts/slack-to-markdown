import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveChannelType,
  deriveFolderName,
  isChannelExcluded,
  matchesChannelFilter,
} from "./config";
import { type ArchiveStore, pickNewerTs } from "./store";
import type {
  ArchiveConfig,
  Logger,
  SeedStats,
  SlackAuthInfo,
  SlackChannel,
  SlackMessage,
  SlackUser,
} from "./types";

const CONVERSATION_FILE_PATTERN = /^[CDG][^.]+\.json$/;

export interface SeedOptions {
  seedDir: string;
  config: ArchiveConfig;
  channelFilter?: string;
  dryRun?: boolean;
  log?: Logger;
  nowMs?: number;
}

export async function seedFromSlackArchive(
  store: ArchiveStore,
  options: SeedOptions,
): Promise<SeedStats> {
  const log = options.log ?? noopLog;
  const nowMs = options.nowMs ?? Date.now();
  const stats: SeedStats = {
    usersImported: 0,
    channelsImported: 0,
    channelsSkippedExcluded: 0,
    messagesImported: 0,
    daysMarkedDirty: 0,
  };

  log(`Seeding from ${options.seedDir}...`);

  const usersRecord = await readJsonFile<Record<string, SlackUser>>(
    path.join(options.seedDir, "users.json"),
    "Slack users metadata",
  );
  const usersList = Object.entries(usersRecord).map(([id, user]) => ({
    ...user,
    id: user.id || id,
  }));

  if (!options.dryRun) {
    stats.usersImported = store.upsertUsers(usersList, nowMs);
  } else {
    stats.usersImported = usersList.length;
  }

  const channelsList = await readJsonFile<SlackChannel[]>(
    path.join(options.seedDir, "channels.json"),
    "Slack channels metadata",
  );

  const channelById = new Map<string, SlackChannel>();
  for (const channel of channelsList) {
    if (channel.id) {
      channelById.set(channel.id, channel);
    }
  }

  const entries = await readdir(options.seedDir);
  for (const entry of entries) {
    if (!CONVERSATION_FILE_PATTERN.test(entry)) {
      continue;
    }
    const channelId = path.basename(entry, ".json");
    if (!channelById.has(channelId)) {
      channelById.set(channelId, inferSyntheticChannel(channelId));
    }
  }

  const userMap = options.dryRun
    ? buildEphemeralUserMap(usersList)
    : store.getUserMap();

  for (const channel of channelById.values()) {
    const channelType = deriveChannelType(channel);
    const preferredFolder = deriveFolderName(channel, userMap);
    const existing = store.getChannel(channel.id);

    const identity = {
      id: channel.id,
      slackName: channel.name ?? existing?.slackName,
      folderName: existing?.folderName ?? preferredFolder,
    };

    if (isChannelExcluded(identity, options.config.exclude)) {
      stats.channelsSkippedExcluded += 1;
      continue;
    }

    if (!matchesChannelFilter(identity, options.channelFilter)) {
      continue;
    }

    const filePath = path.join(options.seedDir, `${channel.id}.json`);
    const rawMessages = await readOptionalJsonArray<SlackMessage>(filePath);
    const { flattened, maxTopLevelTs } = flattenSeedMessages(rawMessages);
    const fullySynced = Boolean(
      channel.is_archived || (channel.is_im && channel.is_user_deleted),
    );

    if (!options.dryRun) {
      store.transaction(() => {
        store.upsertChannel(channel, channelType, preferredFolder);
        const result = store.upsertMessages(channel.id, flattened);
        store.updateChannelSyncState(channel.id, {
          lastMessageTs: maxTopLevelTs,
          lastSyncedAt: nowMs,
          fullySynced,
        });
        stats.messagesImported += result.upserted;
      });
      stats.daysMarkedDirty += store.markAllDaysDirty(channel.id);
    } else {
      stats.messagesImported += flattened.length;
    }

    stats.channelsImported += 1;
  }

  if (!options.dryRun) {
    const archiveMeta = await readOptionalJsonObject<{ auth?: SlackAuthInfo }>(
      path.join(options.seedDir, "slack-archive.json"),
    );
    if (archiveMeta?.auth) {
      store.saveAuth({
        userId: archiveMeta.auth.user_id ?? null,
        user: archiveMeta.auth.user ?? null,
        teamId: archiveMeta.auth.team_id ?? null,
        team: archiveMeta.auth.team ?? null,
      });
    }
    store.setMeta("seeded_from", path.resolve(options.seedDir));
    store.setMeta("seeded_at", new Date(nowMs).toISOString());
  }

  log(
    `Seeded ${stats.usersImported} users, ${stats.channelsImported} channels (${stats.channelsSkippedExcluded} excluded), ${stats.messagesImported} messages.`,
  );

  return stats;
}

export function flattenSeedMessages(rawMessages: readonly SlackMessage[]): {
  flattened: SlackMessage[];
  maxTopLevelTs: string | null;
} {
  const byTs = new Map<string, SlackMessage>();
  let maxTopLevelTs: string | null = null;

  for (const msg of rawMessages) {
    if (!msg.ts) {
      continue;
    }

    maxTopLevelTs = pickNewerTs(maxTopLevelTs, msg.ts);

    const replies = Array.isArray(msg.replies) ? msg.replies : [];
    let latestReply = msg.latest_reply;
    let replyCount = msg.reply_count ?? 0;

    if (replies.length > 0) {
      replyCount = Math.max(replyCount, replies.length);
      for (const reply of replies) {
        if (!reply.ts) {
          continue;
        }
        latestReply = pickNewerTs(latestReply ?? null, reply.ts) ?? undefined;
        const normalizedReply: SlackMessage = {
          ...reply,
          thread_ts: reply.thread_ts ?? msg.ts,
        };
        if (!byTs.has(reply.ts)) {
          byTs.set(reply.ts, normalizedReply);
        }
      }
    }

    const { replies: _stripped, ...parentWithoutReplies } = msg;
    const normalizedParent: SlackMessage = {
      ...parentWithoutReplies,
      ...(replyCount > 0 ? { reply_count: replyCount } : {}),
      ...(latestReply ? { latest_reply: latestReply } : {}),
    };
    byTs.set(msg.ts, normalizedParent);
  }

  return {
    flattened: Array.from(byTs.values()),
    maxTopLevelTs,
  };
}

async function readJsonFile<T>(targetPath: string, label: string): Promise<T> {
  let content: string;
  try {
    content = await readFile(targetPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${targetPath}: ${detail}`);
  }

  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label} at ${targetPath}: ${detail}`);
  }
}

async function readOptionalJsonArray<T>(targetPath: string): Promise<T[]> {
  try {
    const content = await readFile(targetPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readOptionalJsonObject<T>(
  targetPath: string,
): Promise<T | null> {
  try {
    const content = await readFile(targetPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function inferSyntheticChannel(channelId: string): SlackChannel {
  return {
    id: channelId,
    name: channelId,
    is_im: channelId.startsWith("D"),
    is_private: channelId.startsWith("G"),
  };
}

function buildEphemeralUserMap(users: readonly SlackUser[]) {
  const map = new Map<
    string,
    { id: string; name: string; realName: string; displayName: string }
  >();
  for (const user of users) {
    if (!user.id) {
      continue;
    }
    map.set(user.id, {
      id: user.id,
      name: user.name ?? "",
      realName: user.real_name ?? user.profile?.real_name ?? "",
      displayName: user.profile?.display_name ?? "",
    });
  }
  return map;
}

function noopLog(): void {}
