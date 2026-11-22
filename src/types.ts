export const DEFAULT_CHANNEL_TYPES: readonly SlackChannelType[] = [
  "public_channel",
  "private_channel",
  "mpim",
  "im",
];

export const DEFAULT_LOOKBACK_DAYS = 14;
export const STATE_DIR_NAME = ".slack-to-markdown";
export const DB_FILE_NAME = "archive.sqlite";
export const CONFIG_FILE_NAME = "config.json";

export type SlackChannelType =
  | "public_channel"
  | "private_channel"
  | "mpim"
  | "im";

export interface SlackUserProfile {
  display_name?: string;
  display_name_normalized?: string;
  real_name?: string;
  real_name_normalized?: string;
  first_name?: string;
  last_name?: string;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: SlackUserProfile;
}

export interface SlackChannelPurpose {
  value?: string;
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
  is_user_deleted?: boolean;
  user?: string;
  purpose?: SlackChannelPurpose;
  topic?: SlackChannelPurpose;
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  permalink?: string;
  url_private?: string;
}

export interface SlackAttachment {
  author_name?: string;
  title?: string;
  title_link?: string;
  pretext?: string;
  text?: string;
  fallback?: string;
  service_name?: string;
  from_url?: string;
}

export interface SlackMessage {
  ts: string;
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  replies?: SlackMessage[];
}

export interface SlackAuthInfo {
  user_id?: string;
  user?: string;
  team_id?: string;
  team?: string;
  url?: string;
}

export interface StoredUser {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  isBot: boolean;
  deleted: boolean;
  rawJson: string;
  updatedAt: number;
}

export interface StoredChannel {
  id: string;
  type: SlackChannelType;
  slackName: string;
  folderName: string;
  purpose: string;
  isArchived: boolean;
  isUserDeleted: boolean;
  dmUserId: string | null;
  fullySynced: boolean;
  lastMessageTs: string | null;
  lastSyncedAt: number | null;
  rawJson: string;
}

export interface StoredMessage {
  channelId: string;
  ts: string;
  threadTs: string | null;
  dayUtc: string;
  userId: string | null;
  username: string | null;
  subtype: string | null;
  text: string;
  replyCount: number;
  latestReply: string | null;
  rawJson: string;
}

export interface DirtyDay {
  channelId: string;
  dayUtc: string;
}

export interface ArchiveConfig {
  exclude: string[];
  channelTypes: SlackChannelType[];
  lookbackDays: number;
}

export interface CliOptions {
  outputDir: string;
  token?: string;
  seedFrom?: string;
  renderOnly: boolean;
  rerender: boolean;
  exclude: string[];
  channelTypes?: SlackChannelType[];
  lookbackDays?: number;
  channelFilter?: string;
  dryRun: boolean;
  quiet: boolean;
}

export type ParsedCliCommand =
  | { kind: "help"; helpText: string }
  | { kind: "run"; options: CliOptions };

export interface RenderStats {
  daysProcessed: number;
  filesWritten: number;
  filesUnchanged: number;
  filesRemoved: number;
}

export interface SeedStats {
  usersImported: number;
  channelsImported: number;
  channelsSkippedExcluded: number;
  messagesImported: number;
  daysMarkedDirty: number;
}

export interface SyncStats {
  usersSynced: number;
  channelsListed: number;
  channelsSynced: number;
  channelsSkippedArchived: number;
  channelsSkippedExcluded: number;
  channelsErrored: number;
  messagesUpserted: number;
  threadsFetched: number;
  render: RenderStats;
}

export type Logger = (line: string) => void;
