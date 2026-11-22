import {
  deriveChannelType,
  deriveFolderName,
  isChannelExcluded,
  matchesChannelFilter,
} from "./config";
import { renderDirtyDays } from "./render";
import { SlackApiError, type SlackClient } from "./slack-client";
import { type ArchiveStore, pickNewerTs } from "./store";
import type {
  ArchiveConfig,
  Logger,
  SavedAuthState,
  SlackAuthInfo,
  SlackChannel,
  SlackMessage,
  StoredChannel,
  StoredUser,
  SyncStats,
} from "./types";

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * 1_000;
const SEARCH_BUFFER_DAYS = 2;
const USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;

export interface SyncOptions {
  outputDir: string;
  token: string;
  config: ArchiveConfig;
  fullScan?: boolean;
  channelFilter?: string;
  dryRun?: boolean;
  log?: Logger;
  nowMs?: number;
}

export async function syncWorkspace(
  client: SlackClient,
  store: ArchiveStore,
  options: SyncOptions,
): Promise<SyncStats> {
  const log = options.log ?? noopLog;
  const nowMs = options.nowMs ?? Date.now();
  const stats: SyncStats = {
    scanMode: "fast",
    usersSynced: 0,
    channelsListed: 0,
    channelsSynced: 0,
    channelsSkippedArchived: 0,
    channelsSkippedExcluded: 0,
    channelsSkippedInactive: 0,
    channelsErrored: 0,
    messagesUpserted: 0,
    threadsFetched: 0,
    render: {
      daysProcessed: 0,
      filesWritten: 0,
      filesUnchanged: 0,
      filesRemoved: 0,
    },
  };

  const auth = await client.authTest();
  if (!auth.user_id) {
    throw new Error(
      "Slack auth.test response did not include user_id; cannot verify token identity.",
    );
  }

  const savedAuth = store.getSavedAuth();
  verifyTokenIdentity(savedAuth, options.token, auth, log);

  log(
    `Authenticated to Slack workspace ${auth.team ?? "(unknown)"} as ${auth.user ?? auth.user_id} (${auth.user_id})`,
  );

  if (!options.dryRun) {
    store.saveAuth({
      token: options.token,
      userId: auth.user_id,
      user: auth.user ?? null,
      teamId: auth.team_id ?? null,
      team: auth.team ?? null,
    });
  }

  log("Syncing users via users.list...");
  const remoteUsers = await client.listUsers();
  if (!options.dryRun) {
    stats.usersSynced = store.upsertUsers(remoteUsers, nowMs);
  } else {
    stats.usersSynced = remoteUsers.length;
  }
  log(`Synced ${stats.usersSynced} users.`);

  const userMap = store.getUserMap();
  const attemptedUnknownUsers = new Set<string>();

  log(`Listing channels (${options.config.channelTypes.join(", ")})...`);
  const remoteChannels = await client.listChannels(options.config.channelTypes);
  stats.channelsListed = remoteChannels.length;
  log(`Found ${remoteChannels.length} channels.`);

  const lastFullScanIso =
    store.getMeta("last_full_scan_at") ?? store.getMeta("seeded_at");
  let effectiveFullScan =
    Boolean(options.channelFilter) ||
    shouldRunFullScan(
      lastFullScanIso,
      Boolean(options.fullScan),
      options.config.fullScanIntervalDays,
      nowMs,
    );

  let searchActiveIds = new Set<string>();
  let clientCountsLatest = new Map<string, string>();

  if (!effectiveFullScan) {
    let clientCountsOk = false;
    try {
      clientCountsLatest = await client.getClientCounts();
      clientCountsOk = true;
    } catch (error) {
      if (error instanceof SlackApiError && error.kind === "auth") {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(`WARNING: client.counts unavailable (${detail}).`);
    }

    const searchSinceMs = computeSearchSinceMs(
      store.getMeta("last_sync_at") ?? lastFullScanIso,
      nowMs,
    );
    const afterUtcDate = formatUtcDate(searchSinceMs);
    let searchOk = false;
    try {
      searchActiveIds = await client.searchActiveChannelIds(
        afterUtcDate,
        Math.floor(searchSinceMs / 1_000),
      );
      searchOk = true;
    } catch (error) {
      if (error instanceof SlackApiError && error.kind === "auth") {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(`WARNING: search.messages unavailable (${detail}).`);
    }

    if (!clientCountsOk && !searchOk) {
      log(
        "WARNING: both client.counts and search.messages failed; falling back to full scan.",
      );
      effectiveFullScan = true;
    } else {
      const signals: string[] = [];
      if (clientCountsOk) {
        signals.push(`client.counts (${clientCountsLatest.size} timestamps)`);
      }
      if (searchOk) {
        signals.push(
          `search.messages after:${afterUtcDate} (${searchActiveIds.size} active)`,
        );
      }
      log(
        `Fast scan using ${signals.join(" + ")}; also polling channels active within ${options.config.activeWindowDays}d and newly discovered channels.`,
      );
    }
  } else if (!options.channelFilter) {
    log(
      options.fullScan
        ? "Full scan requested via --full-scan: checking all non-archived channels."
        : `Weekly full scan due (interval: ${options.config.fullScanIntervalDays}d): checking all non-archived channels.`,
    );
  }

  stats.scanMode = effectiveFullScan ? "full" : "fast";

  for (let index = 0; index < remoteChannels.length; index += 1) {
    const channel = remoteChannels[index];
    if (!channel?.id) {
      continue;
    }

    if (channel.is_im && channel.user) {
      await ensureUserLoaded(
        channel.user,
        client,
        store,
        userMap,
        attemptedUnknownUsers,
        options.dryRun ?? false,
        nowMs,
      );
    }

    const channelType = deriveChannelType(channel);
    const existing = store.getChannel(channel.id);
    const preferredFolder = deriveFolderName(channel, userMap);
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

    let storedChannel: StoredChannel;
    if (!options.dryRun) {
      storedChannel = store.upsertChannel(
        channel,
        channelType,
        preferredFolder,
      );
    } else {
      storedChannel =
        existing ?? buildDryRunChannel(channel, channelType, preferredFolder);
    }

    if (storedChannel.fullySynced) {
      stats.channelsSkippedArchived += 1;
      continue;
    }

    if (
      !effectiveFullScan &&
      !shouldPollChannelInFastMode(
        storedChannel,
        searchActiveIds,
        clientCountsLatest,
        options.config.activeWindowDays,
        nowMs,
      )
    ) {
      stats.channelsSkippedInactive += 1;
      continue;
    }

    const oldest = computeHistoryOldest(
      storedChannel.lastMessageTs,
      options.config.lookbackDays,
      nowMs,
    );

    try {
      const history = await client.getConversationHistory(channel.id, oldest);
      const { replies, threadsFetched } = await fetchUpdatedThreadReplies(
        client,
        store,
        channel.id,
        history,
      );
      stats.threadsFetched += threadsFetched;

      const combinedMessages = [...history, ...replies];
      const referencedUserIds = collectReferencedUserIds(combinedMessages);
      for (const userId of referencedUserIds) {
        await ensureUserLoaded(
          userId,
          client,
          store,
          userMap,
          attemptedUnknownUsers,
          options.dryRun ?? false,
          nowMs,
        );
      }

      const maxTopLevelTs = findMaxTs(history);
      const fullySynced = Boolean(
        channel.is_archived || (channel.is_im && channel.is_user_deleted),
      );

      let dirtyCount = 0;
      if (!options.dryRun) {
        store.transaction(() => {
          const result = store.upsertMessages(channel.id, combinedMessages);
          stats.messagesUpserted += result.upserted;
          dirtyCount = result.dirtyDays.length;
          store.updateChannelSyncState(channel.id, {
            lastMessageTs: maxTopLevelTs,
            lastSyncedAt: nowMs,
            fullySynced,
          });
        });

        if (dirtyCount > 0) {
          const renderResult = await renderDirtyDays(store, options.outputDir, {
            channelId: channel.id,
            dryRun: false,
          });
          mergeRenderStats(stats.render, renderResult);
        }
      } else {
        stats.messagesUpserted += combinedMessages.length;
      }

      stats.channelsSynced += 1;

      if (combinedMessages.length > 0 || options.channelFilter) {
        log(
          `[${index + 1}/${remoteChannels.length}] ${storedChannel.folderName}: ${history.length} msgs, ${replies.length} replies (${threadsFetched} threads), ${dirtyCount} dirty days`,
        );
      }
    } catch (error) {
      if (error instanceof SlackApiError && error.kind === "auth") {
        throw error;
      }
      stats.channelsErrored += 1;
      const detail = error instanceof Error ? error.message : String(error);
      log(
        `[${index + 1}/${remoteChannels.length}] WARNING: failed syncing ${storedChannel.folderName} (${channel.id}): ${detail}`,
      );
    }
  }

  if (!options.dryRun) {
    const isoNow = new Date(nowMs).toISOString();
    store.setMeta("last_sync_at", isoNow);
    if (effectiveFullScan && !options.channelFilter) {
      store.setMeta("last_full_scan_at", isoNow);
    }
  }

  return stats;
}

export function shouldRunFullScan(
  lastFullScanIso: string | null,
  forceFullScan: boolean,
  intervalDays: number,
  nowMs: number,
): boolean {
  if (forceFullScan || intervalDays <= 0 || !lastFullScanIso) {
    return true;
  }
  const parsed = Date.parse(lastFullScanIso);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return nowMs - parsed >= intervalDays * MS_PER_DAY;
}

export function shouldPollChannelInFastMode(
  channel: StoredChannel,
  searchActiveIds: ReadonlySet<string>,
  clientCountsLatest: ReadonlyMap<string, string>,
  activeWindowDays: number,
  nowMs: number,
): boolean {
  if (channel.lastSyncedAt === null) {
    return true;
  }
  if (searchActiveIds.has(channel.id)) {
    return true;
  }
  const latestFromCounts = clientCountsLatest.get(channel.id);
  if (latestFromCounts) {
    const latestSec = Number.parseFloat(latestFromCounts);
    const storedSec = channel.lastMessageTs
      ? Number.parseFloat(channel.lastMessageTs)
      : 0;
    if (Number.isFinite(latestSec) && latestSec > storedSec) {
      return true;
    }
  }
  if (!channel.lastMessageTs || activeWindowDays <= 0) {
    return false;
  }
  const lastMsgSec = Number.parseFloat(channel.lastMessageTs);
  if (!Number.isFinite(lastMsgSec)) {
    return false;
  }
  const activeCutoffSec =
    Math.floor(nowMs / 1_000) - activeWindowDays * SECONDS_PER_DAY;
  return lastMsgSec >= activeCutoffSec;
}

export function verifyTokenIdentity(
  savedAuth: SavedAuthState | null,
  incomingToken: string,
  auth: SlackAuthInfo,
  log: Logger = noopLog,
): void {
  if (!savedAuth) {
    return;
  }

  const tokenChanged =
    savedAuth.token !== null && savedAuth.token !== incomingToken;
  const expectedUserId = savedAuth.userId;
  const expectedTeamId = savedAuth.teamId;

  const userMismatch =
    expectedUserId !== null && auth.user_id !== expectedUserId;
  const teamMismatch =
    expectedTeamId !== null &&
    Boolean(auth.team_id) &&
    auth.team_id !== expectedTeamId;

  if (userMismatch || teamMismatch) {
    const savedUserLabel = savedAuth.user
      ? `${savedAuth.user} (${savedAuth.userId ?? "unknown"})`
      : (savedAuth.userId ?? "unknown");
    const savedTeamLabel = savedAuth.team
      ? `${savedAuth.team} (${savedAuth.teamId ?? "unknown"})`
      : (savedAuth.teamId ?? "unknown");
    const actualUserLabel = auth.user
      ? `${auth.user} (${auth.user_id ?? "unknown"})`
      : (auth.user_id ?? "unknown");
    const actualTeamLabel = auth.team
      ? `${auth.team} (${auth.team_id ?? "unknown"})`
      : (auth.team_id ?? "unknown");

    throw new Error(
      `Slack token user mismatch: archive belongs to user ${savedUserLabel} in workspace ${savedTeamLabel}, but the provided token authenticates as ${actualUserLabel} in workspace ${actualTeamLabel}. Refusing to sync.`,
    );
  }

  if (tokenChanged) {
    log(
      `Slack token changed; verified it still represents user ${auth.user ?? auth.user_id} (${auth.user_id}). Updating saved token.`,
    );
  }
}

export function computeHistoryOldest(
  lastMessageTs: string | null,
  lookbackDays: number,
  nowMs: number,
): string | undefined {
  if (!lastMessageTs) {
    return undefined;
  }

  const lastTsSec = Number.parseFloat(lastMessageTs);
  if (!Number.isFinite(lastTsSec) || lastTsSec <= 0) {
    return undefined;
  }

  if (lookbackDays <= 0) {
    return lastMessageTs;
  }

  const lookbackCutoffSec = Math.max(
    0,
    Math.floor(nowMs / 1_000) - lookbackDays * SECONDS_PER_DAY,
  );
  return lookbackCutoffSec < lastTsSec
    ? String(lookbackCutoffSec)
    : lastMessageTs;
}

async function fetchUpdatedThreadReplies(
  client: SlackClient,
  store: ArchiveStore,
  channelId: string,
  history: readonly SlackMessage[],
): Promise<{ replies: SlackMessage[]; threadsFetched: number }> {
  const replies: SlackMessage[] = [];
  let threadsFetched = 0;

  for (const msg of history) {
    const incomingReplyCount = msg.reply_count ?? 0;
    if (!msg.ts || incomingReplyCount <= 0) {
      continue;
    }

    const storedState = store.getThreadSyncState(channelId, msg.ts);
    const needsFetch =
      storedState === null ||
      storedState.storedReplyCount < incomingReplyCount ||
      incomingReplyCount > storedState.replyCount ||
      Boolean(msg.latest_reply && msg.latest_reply !== storedState.latestReply);

    if (!needsFetch) {
      continue;
    }

    const threadReplies = await client.getConversationReplies(
      channelId,
      msg.ts,
    );
    for (const reply of threadReplies) {
      replies.push({
        ...reply,
        thread_ts: reply.thread_ts ?? msg.ts,
      });
    }
    threadsFetched += 1;
  }

  return { replies, threadsFetched };
}

async function ensureUserLoaded(
  userId: string,
  client: SlackClient,
  store: ArchiveStore,
  userMap: Map<string, StoredUser>,
  attemptedUnknownUsers: Set<string>,
  dryRun: boolean,
  nowMs: number,
): Promise<void> {
  if (!userId || userMap.has(userId) || attemptedUnknownUsers.has(userId)) {
    return;
  }

  attemptedUnknownUsers.add(userId);
  try {
    const user = await client.getUserInfo(userId);
    if (!user) {
      return;
    }
    if (!dryRun) {
      store.upsertUsers([user], nowMs);
    }
    userMap.set(user.id, {
      id: user.id,
      name: user.name ?? "",
      realName: user.real_name ?? user.profile?.real_name ?? "",
      displayName: user.profile?.display_name ?? "",
      isBot: Boolean(user.is_bot),
      deleted: Boolean(user.deleted),
      rawJson: JSON.stringify(user),
      updatedAt: nowMs,
    });
  } catch (error) {
    if (error instanceof SlackApiError && error.kind === "auth") {
      throw error;
    }
  }
}

function collectReferencedUserIds(messages: readonly SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.user) {
      ids.add(msg.user);
    }
    if (msg.text) {
      for (const match of msg.text.matchAll(USER_MENTION_PATTERN)) {
        if (match[1]) {
          ids.add(match[1]);
        }
      }
    }
  }
  return Array.from(ids);
}

function findMaxTs(messages: readonly SlackMessage[]): string | null {
  let maxTs: string | null = null;
  for (const msg of messages) {
    if (msg.ts) {
      maxTs = pickNewerTs(maxTs, msg.ts);
    }
  }
  return maxTs;
}

function buildDryRunChannel(
  channel: SlackChannel,
  type: StoredChannel["type"],
  folderName: string,
): StoredChannel {
  return {
    id: channel.id,
    type,
    slackName: channel.name ?? "",
    folderName,
    purpose: channel.purpose?.value ?? "",
    isArchived: Boolean(channel.is_archived),
    isUserDeleted: Boolean(channel.is_user_deleted),
    dmUserId: channel.user ?? null,
    fullySynced: false,
    lastMessageTs: null,
    lastSyncedAt: null,
    rawJson: JSON.stringify(channel),
  };
}

function mergeRenderStats(
  target: SyncStats["render"],
  addition: SyncStats["render"],
): void {
  target.daysProcessed += addition.daysProcessed;
  target.filesWritten += addition.filesWritten;
  target.filesUnchanged += addition.filesUnchanged;
  target.filesRemoved += addition.filesRemoved;
}

function computeSearchSinceMs(
  lastSyncIso: string | null,
  nowMs: number,
): number {
  const defaultSince = nowMs - SEARCH_BUFFER_DAYS * MS_PER_DAY;
  if (!lastSyncIso) {
    return defaultSince;
  }
  const parsed = Date.parse(lastSyncIso);
  if (!Number.isFinite(parsed)) {
    return defaultSince;
  }
  return Math.min(parsed - SEARCH_BUFFER_DAYS * MS_PER_DAY, defaultSince);
}

function formatUtcDate(epochMs: number): string {
  const date = new Date(Math.max(0, epochMs));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function noopLog(): void {}
