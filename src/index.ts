#!/usr/bin/env bun

import path from "node:path";

import {
  isChannelExcluded,
  loadArchiveConfig,
  matchesChannelFilter,
  parseChannelTypes,
  resolveStatePaths,
} from "./config";
import { renderDirtyDays } from "./render";
import { seedFromSlackArchive } from "./seed";
import { SlackClient } from "./slack-client";
import { ArchiveStore } from "./store";
import { syncWorkspace } from "./sync";
import {
  type CliOptions,
  CONFIG_FILE_NAME,
  DB_FILE_NAME,
  DEFAULT_CHANNEL_TYPES,
  DEFAULT_LOOKBACK_DAYS,
  type Logger,
  type ParsedCliCommand,
  type RenderStats,
  type SlackChannelType,
  STATE_DIR_NAME,
} from "./types";

const HELP_TEXT = `Usage: slack-to-markdown <output-dir> [options]

Incrementally sync a Slack workspace into LLM-friendly YYYY-MM-DD.txt daily logs
without touching existing YYYY-MM.txt monthly summaries or .monthly-summaries.json.

State is stored in <output-dir>/${STATE_DIR_NAME}/${DB_FILE_NAME}.
Optional persistent config is loaded from <output-dir>/${STATE_DIR_NAME}/${CONFIG_FILE_NAME}.

Token:
  Provide via --token <xoxp-...> or the SLACK_TOKEN environment variable.
  Not required when using --render-only.

Options:
  --token TOKEN          Slack API token (overrides SLACK_TOKEN env var).
  --seed-from DIR        Import an existing slack-archive JSON data directory into
                         SQLite and re-render all historical day files.
  --render-only          Skip Slack API calls; only render dirty (or --rerender) days.
  --rerender             Mark all stored days dirty and re-render YYYY-MM-DD.txt files.
  --exclude NAME_OR_ID   Exclude a channel by ID, Slack name, or folder name (repeatable).
  --channel-types LIST   Comma-separated channel types
                         (default: ${DEFAULT_CHANNEL_TYPES.join(",")}).
  --lookback-days N      Rolling history lookback window in days for catching thread
                         replies and edits (default: ${DEFAULT_LOOKBACK_DAYS}).
  --channel NAME_OR_ID   Limit sync/seed/render to a single channel.
  --dry-run              Preview work without writing files or mutating SQLite.
  --quiet, -q            Suppress progress output.
  --help, -h             Show this help text.`;

export interface RunCliInput {
  argv?: string[];
  env?: Record<string, string | undefined>;
  log?: Logger;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowMs?: number;
}

export async function runCli(input: RunCliInput = {}): Promise<void> {
  const rawLog = input.log ?? defaultLog;
  const command = parseCliCommand(input.argv ?? process.argv.slice(2));

  switch (command.kind) {
    case "help":
      rawLog(command.helpText);
      return;
    case "run":
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unsupported command kind: ${String(exhaustive)}`);
    }
  }

  const { options } = command;
  const log: Logger = options.quiet ? noopLog : rawLog;
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const outputDir = path.resolve(options.outputDir);

  const config = await loadArchiveConfig(outputDir, {
    exclude: options.exclude,
    channelTypes: options.channelTypes,
    lookbackDays: options.lookbackDays,
  });

  const token = (options.token ?? env.SLACK_TOKEN ?? "").trim();
  if (!options.renderOnly && token.length === 0) {
    throw new Error(
      "Missing Slack token. Pass --token <token> or set SLACK_TOKEN (or use --render-only).",
    );
  }

  const { dbPath } = resolveStatePaths(outputDir);
  const store = new ArchiveStore(dbPath);

  try {
    if (options.seedFrom) {
      await seedFromSlackArchive(store, {
        seedDir: path.resolve(options.seedFrom),
        config,
        channelFilter: options.channelFilter,
        dryRun: options.dryRun,
        log,
        nowMs: input.nowMs,
      });
    }

    if (options.rerender && !options.dryRun) {
      const marked = markMatchingChannelsDirty(
        store,
        config.exclude,
        options.channelFilter,
      );
      log(`Marked ${marked} day(s) for re-rendering.`);
    }

    const renderTotals: RenderStats = {
      daysProcessed: 0,
      filesWritten: 0,
      filesUnchanged: 0,
      filesRemoved: 0,
    };

    if (!options.renderOnly) {
      const client = new SlackClient({
        token,
        fetchImpl: input.fetchImpl,
        sleepImpl: input.sleepImpl,
        onRateLimit: (method, waitMs) => {
          log(
            `Rate limited on ${method}; waiting ${(waitMs / 1_000).toFixed(1)}s...`,
          );
        },
      });

      const syncStats = await syncWorkspace(client, store, {
        outputDir,
        config,
        channelFilter: options.channelFilter,
        dryRun: options.dryRun,
        log,
        nowMs: input.nowMs,
      });

      accumulateRenderStats(renderTotals, syncStats.render);
      log(
        `Sync complete: ${syncStats.channelsSynced} channels synced, ${syncStats.channelsSkippedArchived} archived skipped, ${syncStats.channelsSkippedExcluded} excluded, ${syncStats.channelsErrored} errors, ${syncStats.messagesUpserted} messages, ${syncStats.threadsFetched} threads.`,
      );
    }

    const remainingRender = await renderRemainingDirtyChannels(
      store,
      outputDir,
      config.exclude,
      options.channelFilter,
      options.dryRun,
    );
    accumulateRenderStats(renderTotals, remainingRender);

    log(
      `Rendered ${renderTotals.daysProcessed} day(s): ${renderTotals.filesWritten} written, ${renderTotals.filesUnchanged} unchanged, ${renderTotals.filesRemoved} removed.`,
    );
  } finally {
    store.close();
  }
}

export function parseCliCommand(argv: readonly string[]): ParsedCliCommand {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help", helpText: HELP_TEXT };
  }

  const positionals: string[] = [];
  let token: string | undefined;
  let seedFrom: string | undefined;
  let renderOnly = false;
  let rerender = false;
  const exclude: string[] = [];
  let channelTypes: SlackChannelType[] | undefined;
  let lookbackDays: number | undefined;
  let channelFilter: string | undefined;
  let dryRun = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case "--token":
        token = requireFlagValue(argv, i, arg);
        i += 1;
        break;
      case "--seed-from":
        seedFrom = requireFlagValue(argv, i, arg);
        i += 1;
        break;
      case "--render-only":
        renderOnly = true;
        break;
      case "--rerender":
        rerender = true;
        break;
      case "--exclude":
        exclude.push(requireFlagValue(argv, i, arg));
        i += 1;
        break;
      case "--channel-types":
        channelTypes = parseChannelTypes(requireFlagValue(argv, i, arg));
        i += 1;
        break;
      case "--lookback-days":
        lookbackDays = parseNonNegativeInt(requireFlagValue(argv, i, arg), arg);
        i += 1;
        break;
      case "--channel":
        channelFilter = requireFlagValue(argv, i, arg);
        i += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--quiet":
      case "-q":
        quiet = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positionals.push(arg);
        break;
    }
  }

  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error(
      `Expected exactly 1 positional argument (<output-dir>); got ${positionals.length}. Run with --help for usage.`,
    );
  }

  const options: CliOptions = {
    outputDir: positionals[0],
    token,
    seedFrom,
    renderOnly,
    rerender,
    exclude,
    channelTypes,
    lookbackDays,
    channelFilter,
    dryRun,
    quiet,
  };

  return { kind: "run", options };
}

function markMatchingChannelsDirty(
  store: ArchiveStore,
  exclusions: readonly string[],
  channelFilter: string | undefined,
): number {
  let total = 0;
  for (const channel of store.getAllChannels()) {
    const identity = {
      id: channel.id,
      slackName: channel.slackName,
      folderName: channel.folderName,
    };
    if (isChannelExcluded(identity, exclusions)) {
      continue;
    }
    if (!matchesChannelFilter(identity, channelFilter)) {
      continue;
    }
    total += store.markAllDaysDirty(channel.id);
  }
  return total;
}

async function renderRemainingDirtyChannels(
  store: ArchiveStore,
  outputDir: string,
  exclusions: readonly string[],
  channelFilter: string | undefined,
  dryRun: boolean,
): Promise<RenderStats> {
  const totals: RenderStats = {
    daysProcessed: 0,
    filesWritten: 0,
    filesUnchanged: 0,
    filesRemoved: 0,
  };

  const dirtyChannelIds = new Set(
    store.getDirtyDays().map((entry) => entry.channelId),
  );
  if (dirtyChannelIds.size === 0) {
    return totals;
  }

  for (const channel of store.getAllChannels()) {
    if (!dirtyChannelIds.has(channel.id)) {
      continue;
    }
    const identity = {
      id: channel.id,
      slackName: channel.slackName,
      folderName: channel.folderName,
    };
    if (isChannelExcluded(identity, exclusions)) {
      continue;
    }
    if (!matchesChannelFilter(identity, channelFilter)) {
      continue;
    }

    const stats = await renderDirtyDays(store, outputDir, {
      channelId: channel.id,
      dryRun,
    });
    accumulateRenderStats(totals, stats);
  }

  return totals;
}

function accumulateRenderStats(
  target: RenderStats,
  addition: RenderStats,
): void {
  target.daysProcessed += addition.daysProcessed;
  target.filesWritten += addition.filesWritten;
  target.filesUnchanged += addition.filesUnchanged;
  target.filesRemoved += addition.filesRemoved;
}

function requireFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function defaultLog(line: string): void {
  console.log(line);
}

function noopLog(): void {}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
