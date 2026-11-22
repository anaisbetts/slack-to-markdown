import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type ArchiveConfig,
  CONFIG_FILE_NAME,
  DB_FILE_NAME,
  DEFAULT_CHANNEL_TYPES,
  DEFAULT_LOOKBACK_DAYS,
  type SlackChannel,
  type SlackChannelType,
  STATE_DIR_NAME,
  type StoredUser,
} from "./types";

const VALID_CHANNEL_TYPES = new Set<string>(DEFAULT_CHANNEL_TYPES);
const UNKNOWN_FOLDER_NAME = "unknown-channel";

export interface StatePaths {
  stateDir: string;
  dbPath: string;
  configPath: string;
}

export interface ChannelIdentity {
  id: string;
  slackName?: string | null;
  folderName?: string | null;
}

export type FolderUserLookup = Map<
  string,
  Pick<StoredUser, "id" | "name" | "realName" | "displayName">
>;

export async function loadArchiveConfig(
  outputDir: string,
  overrides: Partial<ArchiveConfig> = {},
): Promise<ArchiveConfig> {
  const { configPath } = resolveStatePaths(outputDir);
  const fileConfig = await readConfigFile(configPath);

  const exclude = dedupeStrings([
    ...(fileConfig.exclude ?? []),
    ...(overrides.exclude ?? []),
  ]);
  const channelTypes = overrides.channelTypes ??
    fileConfig.channelTypes ?? [...DEFAULT_CHANNEL_TYPES];
  const lookbackDays =
    overrides.lookbackDays ?? fileConfig.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  return {
    exclude,
    channelTypes,
    lookbackDays,
  };
}

export function resolveStatePaths(outputDir: string): StatePaths {
  const resolvedOutput = path.resolve(outputDir);
  const stateDir = path.join(resolvedOutput, STATE_DIR_NAME);
  return {
    stateDir,
    dbPath: path.join(stateDir, DB_FILE_NAME),
    configPath: path.join(stateDir, CONFIG_FILE_NAME),
  };
}

export function isChannelExcluded(
  channel: ChannelIdentity,
  exclusions: readonly string[],
): boolean {
  if (exclusions.length === 0) {
    return false;
  }

  const normalizedExclusions = new Set(
    exclusions.map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  if (normalizedExclusions.size === 0) {
    return false;
  }

  const candidates = [channel.id, channel.slackName, channel.folderName];
  for (const candidate of candidates) {
    if (candidate && normalizedExclusions.has(candidate.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function matchesChannelFilter(
  channel: ChannelIdentity,
  filter: string | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  const needle = filter.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [channel.id, channel.slackName, channel.folderName].some(
    (candidate) => candidate?.trim().toLowerCase() === needle,
  );
}

export function deriveChannelType(channel: SlackChannel): SlackChannelType {
  if (channel.is_im) {
    return "im";
  }
  if (channel.is_mpim) {
    return "mpim";
  }
  if (channel.is_private || channel.is_group) {
    return "private_channel";
  }
  return "public_channel";
}

export function deriveFolderName(
  channel: SlackChannel,
  users: FolderUserLookup,
): string {
  const channelType = deriveChannelType(channel);

  switch (channelType) {
    case "im": {
      if (channel.name?.trim()) {
        return sanitizeFolderName(stripAtSigns(channel.name));
      }
      const user = channel.user ? users.get(channel.user) : undefined;
      if (user) {
        const display =
          user.displayName || user.realName || user.name || user.id;
        const label = user.name ? `${display} (${user.name})` : display;
        return sanitizeFolderName(stripAtSigns(label));
      }
      return sanitizeFolderName(channel.user ?? channel.id);
    }
    case "mpim": {
      const purpose = channel.purpose?.value?.trim();
      const raw = purpose || channel.name || channel.id;
      return sanitizeFolderName(stripAtSigns(raw));
    }
    case "public_channel":
    case "private_channel": {
      const raw = channel.name || channel.purpose?.value || channel.id;
      return sanitizeFolderName(stripAtSigns(raw));
    }
    default: {
      const exhaustive: never = channelType;
      throw new Error(`Unsupported channel type: ${String(exhaustive)}`);
    }
  }
}

export function parseChannelTypes(raw: string): SlackChannelType[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("--channel-types must include at least one valid type");
  }

  const result: SlackChannelType[] = [];
  for (const part of parts) {
    if (!VALID_CHANNEL_TYPES.has(part)) {
      throw new Error(
        `Invalid channel type "${part}". Valid types: ${DEFAULT_CHANNEL_TYPES.join(", ")}`,
      );
    }
    const typed = part as SlackChannelType;
    if (!result.includes(typed)) {
      result.push(typed);
    }
  }

  return result;
}

export function sanitizeFolderName(raw: string): string {
  const cleaned = removeControlCharacters(raw)
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
    return UNKNOWN_FOLDER_NAME;
  }

  return cleaned;
}

async function readConfigFile(
  configPath: string,
): Promise<Partial<ArchiveConfig>> {
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${configPath}: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config in ${configPath} must be a JSON object`);
  }

  const result: Partial<ArchiveConfig> = {};

  if (parsed.exclude !== undefined) {
    if (
      !Array.isArray(parsed.exclude) ||
      !parsed.exclude.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Config "exclude" in ${configPath} must be a string array`,
      );
    }
    result.exclude = parsed.exclude;
  }

  if (parsed.channelTypes !== undefined) {
    if (
      !Array.isArray(parsed.channelTypes) ||
      !parsed.channelTypes.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Config "channelTypes" in ${configPath} must be a string array`,
      );
    }
    result.channelTypes = parseChannelTypes(parsed.channelTypes.join(","));
  }

  if (parsed.lookbackDays !== undefined) {
    if (
      typeof parsed.lookbackDays !== "number" ||
      !Number.isInteger(parsed.lookbackDays) ||
      parsed.lookbackDays < 0
    ) {
      throw new Error(
        `Config "lookbackDays" in ${configPath} must be a non-negative integer`,
      );
    }
    result.lookbackDays = parsed.lookbackDays;
  }

  return result;
}

function stripAtSigns(value: string): string {
  return value.replace(/@/g, "");
}

function removeControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
