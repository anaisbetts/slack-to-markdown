import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { type ArchiveStore, slackTsToUtcDay } from "./store";
import type {
  RenderStats,
  SlackAttachment,
  SlackFile,
  SlackMessage,
  StoredChannel,
  StoredMessage,
  StoredUser,
} from "./types";

const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_archive",
  "channel_unarchive",
  "tombstone",
  "bot_add",
  "bot_remove",
  "bot_disable",
  "pinned_item",
]);

const PARENT_SNIPPET_MAX_CHARS = 120;
const ATTACHMENT_TEXT_MAX_CHARS = 500;

export interface RenderContext {
  users: Map<string, StoredUser>;
  channels: Map<string, StoredChannel>;
}

export interface RenderOptions {
  channelId?: string;
  dryRun?: boolean;
}

interface ParsedMessagePayload {
  botId?: string;
  files: SlackFile[];
  attachments: SlackAttachment[];
}

interface RenderableMessage {
  stored: StoredMessage;
  senderKey: string;
  senderName: string;
  body: string;
  segmentKey: string;
}

type SegmentItem =
  | {
      kind: "message";
      message: RenderableMessage;
      sameDayReplies: RenderableMessage[];
    }
  | {
      kind: "cross_day_thread";
      parentTs: string;
      header: string;
      replies: RenderableMessage[];
    };

export async function renderDirtyDays(
  store: ArchiveStore,
  outputDir: string,
  options: RenderOptions = {},
): Promise<RenderStats> {
  const stats: RenderStats = {
    daysProcessed: 0,
    filesWritten: 0,
    filesUnchanged: 0,
    filesRemoved: 0,
  };

  const dirtyDays = store.getDirtyDays(options.channelId);
  if (dirtyDays.length === 0) {
    return stats;
  }

  const users = store.getUserMap();
  const channelList = store.getAllChannels();
  const channels = new Map<string, StoredChannel>();
  for (const ch of channelList) {
    channels.set(ch.id, ch);
  }
  const context: RenderContext = { users, channels };

  for (const dirty of dirtyDays) {
    const channel = channels.get(dirty.channelId);
    if (!channel) {
      if (!options.dryRun) {
        store.clearDirtyDay(dirty.channelId, dirty.dayUtc);
      }
      continue;
    }

    stats.daysProcessed += 1;
    const dayMessages = store.getMessagesForDay(dirty.channelId, dirty.dayUtc);
    const parentTimestamps = collectCrossDayParentTimestamps(dayMessages);
    const externalParents = store.getMessagesByTs(
      dirty.channelId,
      parentTimestamps,
    );

    const rendered = renderDayContent(dayMessages, externalParents, context);
    const outPath = path.join(
      outputDir,
      channel.folderName,
      `${dirty.dayUtc}.txt`,
    );

    if (rendered === null) {
      const existing = await readOptionalText(outPath);
      if (existing !== null) {
        if (!options.dryRun) {
          await rm(outPath, { force: true });
        }
        stats.filesRemoved += 1;
      } else {
        stats.filesUnchanged += 1;
      }
    } else {
      const existing = await readOptionalText(outPath);
      if (existing === rendered) {
        stats.filesUnchanged += 1;
      } else {
        if (!options.dryRun) {
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, rendered, "utf-8");
        }
        stats.filesWritten += 1;
      }
    }

    if (!options.dryRun) {
      store.clearDirtyDay(dirty.channelId, dirty.dayUtc);
    }
  }

  return stats;
}

export function renderDayContent(
  dayMessages: readonly StoredMessage[],
  externalParents: Map<string, StoredMessage>,
  context: RenderContext,
): string | null {
  const byTs = new Map<string, StoredMessage>();
  for (const msg of dayMessages) {
    byTs.set(msg.ts, msg);
  }

  const renderableByTs = new Map<string, RenderableMessage>();
  const orderedRenderables: RenderableMessage[] = [];
  for (const msg of dayMessages) {
    const renderable = toRenderableMessage(msg, context);
    if (!renderable) {
      continue;
    }
    renderableByTs.set(msg.ts, renderable);
    orderedRenderables.push(renderable);
  }

  if (orderedRenderables.length === 0) {
    return null;
  }

  const sameDayRepliesByParent = new Map<string, RenderableMessage[]>();
  const crossDayReplies: RenderableMessage[] = [];
  const topLevelMessages: RenderableMessage[] = [];

  for (const item of orderedRenderables) {
    const threadTs = item.stored.threadTs;
    const isReply = threadTs !== null && threadTs !== item.stored.ts;

    if (!isReply) {
      topLevelMessages.push(item);
      continue;
    }

    if (renderableByTs.has(threadTs)) {
      const bucket = sameDayRepliesByParent.get(threadTs) ?? [];
      bucket.push(item);
      sameDayRepliesByParent.set(threadTs, bucket);
    } else {
      crossDayReplies.push(item);
    }
  }

  // Build ordered segments combining top-level messages and cross-day thread groups.
  const segments = buildDaySegments(
    topLevelMessages,
    sameDayRepliesByParent,
    crossDayReplies,
    byTs,
    externalParents,
    context,
  );

  // Collect speakers in order of appearance in the rendered output for the Users legend.
  const orderedSpeakers: Array<{ key: string; name: string }> = [];
  const seenSpeakers = new Set<string>();
  const registerSpeaker = (msg: RenderableMessage) => {
    if (!seenSpeakers.has(msg.senderKey)) {
      seenSpeakers.add(msg.senderKey);
      orderedSpeakers.push({ key: msg.senderKey, name: msg.senderName });
    }
  };

  for (const items of segments.values()) {
    for (const item of items) {
      switch (item.kind) {
        case "message":
          registerSpeaker(item.message);
          for (const reply of item.sameDayReplies) {
            registerSpeaker(reply);
          }
          break;
        case "cross_day_thread":
          for (const reply of item.replies) {
            registerSpeaker(reply);
          }
          break;
        default: {
          const exhaustive: never = item;
          throw new Error(`Unexpected segment item: ${String(exhaustive)}`);
        }
      }
    }
  }

  const abbrevMap = buildAbbreviationMap(orderedSpeakers);
  const lines: string[] = ["Users:"];
  for (const speaker of orderedSpeakers) {
    lines.push(`${abbrevMap.get(speaker.key) ?? "?"} - ${speaker.name}`);
  }
  lines.push("");

  for (const [segmentKey, items] of segments) {
    lines.push(segmentKey);
    for (const item of items) {
      switch (item.kind) {
        case "message": {
          appendMessageLines(lines, item.message, abbrevMap, "");
          for (const reply of item.sameDayReplies) {
            appendMessageLines(lines, reply, abbrevMap, "  > ");
          }
          break;
        }
        case "cross_day_thread": {
          lines.push(item.header);
          for (const reply of item.replies) {
            appendMessageLines(lines, reply, abbrevMap, "  > ");
          }
          break;
        }
        default: {
          const exhaustive: never = item;
          throw new Error(`Unexpected segment item: ${String(exhaustive)}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function resolveSlackMarkup(
  rawText: string,
  context: RenderContext,
): string {
  if (!rawText) {
    return "";
  }

  const resolved = rawText
    // User mentions: <@U12345|handle> or <@U12345>
    .replace(
      /<@([A-Z0-9]+)(?:\|([^>]+))?>/g,
      (_match, userId: string, label?: string) => {
        const user = context.users.get(userId);
        if (user) {
          return user.realName || user.displayName || user.name || userId;
        }
        return label ? `@${label}` : `@${userId}`;
      },
    )
    // Channel mentions: <#C12345|general> or <#C12345>
    .replace(
      /<#([A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_match, channelId: string, label?: string) => {
        const channel = context.channels.get(channelId);
        const name = channel?.slackName || label || channelId;
        return `#${name}`;
      },
    )
    // User group mentions: <!subteam^S123|@eng>
    .replace(
      /<!subteam\^[A-Z0-9]+\|([^>]+)>/g,
      (_match, label: string) => label,
    )
    // Special mentions: <!here>, <!channel>, <!everyone>
    .replace(
      /<!(here|channel|everyone)(?:\|[^>]+)?>/g,
      (_match, keyword: string) => `@${keyword}`,
    )
    // Date tokens: <!date^...|fallback>
    .replace(
      /<!date\^[^|>]+\|([^>]+)>/g,
      (_match, fallback: string) => fallback,
    )
    // Mailto links: <mailto:a@b.com|a@b.com>
    .replace(
      /<mailto:([^|>]+)(?:\|([^>]+))?>/g,
      (_match, addr: string, label?: string) =>
        label && label !== addr ? `${label} (${addr})` : addr,
    )
    // URLs with or without labels: <https://...|label>
    .replace(
      /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g,
      (_match, url: string, label?: string) => {
        if (!label || label === url) {
          return url;
        }
        return `[${label}](${url})`;
      },
    );

  return decodeHtmlEntities(resolved);
}

export function buildAbbreviationMap(
  speakers: readonly { key: string; name: string }[],
): Map<string, string> {
  const abbrevs = new Map<string, string>();
  const firstWords = new Map<string, string>();
  const lengths = new Map<string, number>();

  for (const { key, name } of speakers) {
    const firstWord =
      (name.trim().split(/\s+/)[0] ?? name).toLowerCase() || "?";
    firstWords.set(key, firstWord);
    abbrevs.set(key, firstWord[0] ?? "?");
    lengths.set(key, 1);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groupKeysByValue(abbrevs).values()) {
      if (group.length <= 1) {
        continue;
      }
      for (const key of group) {
        const word = firstWords.get(key) ?? "?";
        const currentLen = lengths.get(key) ?? 1;
        if (currentLen < word.length) {
          const nextLen = currentLen + 1;
          lengths.set(key, nextLen);
          abbrevs.set(key, word.slice(0, nextLen));
          changed = true;
        }
      }
    }
  }

  for (const group of groupKeysByValue(abbrevs).values()) {
    if (group.length <= 1) {
      continue;
    }
    group.forEach((key, index) => {
      abbrevs.set(key, `${abbrevs.get(key) ?? "?"}${index + 1}`);
    });
  }

  return abbrevs;
}

function buildDaySegments(
  topLevelMessages: readonly RenderableMessage[],
  sameDayRepliesByParent: Map<string, RenderableMessage[]>,
  crossDayReplies: readonly RenderableMessage[],
  sameDayRawByTs: Map<string, StoredMessage>,
  externalParents: Map<string, StoredMessage>,
  context: RenderContext,
): Map<string, SegmentItem[]> {
  type ChronologicalEvent =
    | { kind: "top"; tsNum: number; message: RenderableMessage }
    | { kind: "cross_reply"; tsNum: number; reply: RenderableMessage };

  const events: ChronologicalEvent[] = [];
  for (const message of topLevelMessages) {
    events.push({
      kind: "top",
      tsNum: Number.parseFloat(message.stored.ts),
      message,
    });
  }
  for (const reply of crossDayReplies) {
    events.push({
      kind: "cross_reply",
      tsNum: Number.parseFloat(reply.stored.ts),
      reply,
    });
  }
  events.sort((a, b) => a.tsNum - b.tsNum);

  const segments = new Map<string, SegmentItem[]>();
  for (const event of events) {
    switch (event.kind) {
      case "top": {
        const segKey = event.message.segmentKey;
        const list = segments.get(segKey) ?? [];
        list.push({
          kind: "message",
          message: event.message,
          sameDayReplies:
            sameDayRepliesByParent.get(event.message.stored.ts) ?? [],
        });
        segments.set(segKey, list);
        break;
      }
      case "cross_reply": {
        const segKey = event.reply.segmentKey;
        const parentTs = event.reply.stored.threadTs ?? event.reply.stored.ts;
        const list = segments.get(segKey) ?? [];
        const existingGroup = list.find(
          (item): item is Extract<SegmentItem, { kind: "cross_day_thread" }> =>
            item.kind === "cross_day_thread" && item.parentTs === parentTs,
        );
        if (existingGroup) {
          existingGroup.replies.push(event.reply);
        } else {
          const parent =
            externalParents.get(parentTs) ?? sameDayRawByTs.get(parentTs);
          list.push({
            kind: "cross_day_thread",
            parentTs,
            header: formatCrossDayThreadHeader(parentTs, parent, context),
            replies: [event.reply],
          });
        }
        segments.set(segKey, list);
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(
          `Unexpected chronological event: ${String(exhaustive)}`,
        );
      }
    }
  }

  return segments;
}

function toRenderableMessage(
  msg: StoredMessage,
  context: RenderContext,
): RenderableMessage | null {
  if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) {
    return null;
  }

  const payload = parseMessagePayload(msg.rawJson);
  const senderKey = msg.userId ?? msg.username ?? payload.botId ?? null;
  if (!senderKey) {
    return null;
  }

  const body = buildMessageBody(msg, payload, context);
  if (body.length === 0) {
    return null;
  }

  return {
    stored: msg,
    senderKey,
    senderName: resolveSenderName(msg, payload.botId, context.users),
    body,
    segmentKey: slackTsToSegmentKey(msg.ts),
  };
}

function buildMessageBody(
  msg: StoredMessage,
  payload: ParsedMessagePayload,
  context: RenderContext,
): string {
  const parts: string[] = [];
  const resolvedText = resolveSlackMarkup(msg.text, context).trim();
  if (resolvedText.length > 0) {
    parts.push(resolvedText);
  }

  const lowerText = resolvedText.toLowerCase();
  for (const file of payload.files) {
    if (isFileAlreadyMentionedInText(file, lowerText)) {
      continue;
    }
    const formatted = formatFile(file);
    if (formatted) {
      parts.push(formatted);
    }
  }

  for (const attachment of payload.attachments) {
    const formatted = formatAttachment(attachment, resolvedText, context);
    if (formatted) {
      parts.push(formatted);
    }
  }

  return parts.join("\n");
}

function formatFile(file: SlackFile): string | null {
  const name = file.name?.trim() ?? "";
  const title = file.title?.trim() ?? "";
  if (title && name && title.toLowerCase() !== name.toLowerCase()) {
    return `[file: ${title} (${name})]`;
  }
  if (name) {
    return `[file: ${name}]`;
  }
  if (title) {
    return `[file: ${title}]`;
  }
  return "[file]";
}

function isFileAlreadyMentionedInText(
  file: SlackFile,
  lowerMessageText: string,
): boolean {
  if (!lowerMessageText) {
    return false;
  }
  const name = file.name?.trim().toLowerCase();
  const title = file.title?.trim().toLowerCase();
  if (name && lowerMessageText.includes(name)) {
    return true;
  }
  if (title && lowerMessageText.includes(title)) {
    return true;
  }
  return false;
}

function formatAttachment(
  attachment: SlackAttachment,
  messageText: string,
  context: RenderContext,
): string | null {
  const pieces: string[] = [];

  const pretext = attachment.pretext
    ? resolveSlackMarkup(attachment.pretext, context).trim()
    : "";
  const author = attachment.author_name?.trim() ?? "";
  const title = attachment.title
    ? resolveSlackMarkup(attachment.title, context).trim()
    : "";
  const titleLink = attachment.title_link?.trim() ?? "";
  const text = attachment.text
    ? resolveSlackMarkup(attachment.text, context).trim()
    : "";
  const fallback = attachment.fallback
    ? resolveSlackMarkup(attachment.fallback, context).trim()
    : "";

  if (pretext) {
    pieces.push(pretext);
  }
  if (title) {
    const formattedTitle =
      titleLink && !title.includes(titleLink)
        ? `[${title}](${titleLink})`
        : title;
    pieces.push(author ? `${author}: ${formattedTitle}` : formattedTitle);
  } else if (author && text) {
    pieces.push(author);
  }

  if (text) {
    pieces.push(truncateText(text, ATTACHMENT_TEXT_MAX_CHARS));
  } else if (pieces.length === 0 && fallback) {
    pieces.push(truncateText(fallback, ATTACHMENT_TEXT_MAX_CHARS));
  }

  const combined = pieces.join(" — ").trim();
  if (!combined) {
    return null;
  }

  if (messageText?.includes(combined)) {
    return null;
  }

  return `[attachment: ${combined}]`;
}

function formatCrossDayThreadHeader(
  parentTs: string,
  parent: StoredMessage | undefined,
  context: RenderContext,
): string {
  const parentDay =
    parent?.dayUtc ?? slackTsToUtcDay(parentTs) ?? "unknown-date";
  if (!parent) {
    return `[Thread from ${parentDay}]`;
  }

  if (parent.subtype === "tombstone") {
    return `[Thread from ${parentDay} (deleted message)]`;
  }

  const payload = parseMessagePayload(parent.rawJson);
  const author = resolveSenderName(parent, payload.botId, context.users);
  const body = buildMessageBody(parent, payload, context);
  const singleLine = body.replace(/\s+/g, " ").trim();

  if (!singleLine) {
    return `[Thread from ${parentDay} by ${author}]`;
  }

  const snippet = truncateText(singleLine, PARENT_SNIPPET_MAX_CHARS);
  return `[Thread from ${parentDay} by ${author}: "${snippet}"]`;
}

function appendMessageLines(
  lines: string[],
  message: RenderableMessage,
  abbrevMap: Map<string, string>,
  prefix: string,
): void {
  const abbrev = abbrevMap.get(message.senderKey) ?? "?";
  const [firstLine = "", ...rest] = message.body.split("\n");
  lines.push(`${prefix}${abbrev}: ${firstLine}`);
  const continuationPrefix = prefix.length > 0 ? `${prefix} ` : " ";
  for (const line of rest) {
    lines.push(`${continuationPrefix}${line}`);
  }
}

function collectCrossDayParentTimestamps(
  dayMessages: readonly StoredMessage[],
): string[] {
  const sameDaySet = new Set(dayMessages.map((msg) => msg.ts));
  const external: string[] = [];
  for (const msg of dayMessages) {
    if (
      msg.threadTs &&
      msg.threadTs !== msg.ts &&
      !sameDaySet.has(msg.threadTs)
    ) {
      external.push(msg.threadTs);
    }
  }
  return external;
}

function resolveSenderName(
  msg: StoredMessage,
  botId: string | undefined,
  users: Map<string, StoredUser>,
): string {
  if (msg.userId) {
    const user = users.get(msg.userId);
    if (user) {
      return user.realName || user.displayName || user.name || msg.userId;
    }
    return msg.userId;
  }
  return msg.username ?? botId ?? "?";
}

function parseMessagePayload(rawJson: string): ParsedMessagePayload {
  try {
    const parsed = JSON.parse(rawJson) as SlackMessage;
    return {
      botId: parsed.bot_id,
      files: Array.isArray(parsed.files) ? parsed.files : [],
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    };
  } catch {
    return { files: [], attachments: [] };
  }
}

function slackTsToSegmentKey(ts: string): string {
  const seconds = Number.parseFloat(ts);
  const date = new Date((Number.isFinite(seconds) ? seconds : 0) * 1000);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minuteBucket = Math.floor(date.getUTCMinutes() / 10) * 10;
  return `${hour}:${String(minuteBucket).padStart(2, "0")}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function groupKeysByValue(map: Map<string, string>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of map) {
    const bucket = grouped.get(value) ?? [];
    bucket.push(key);
    grouped.set(value, bucket);
  }
  return grouped;
}

async function readOptionalText(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
