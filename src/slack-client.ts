import { setTimeout as delay } from "node:timers/promises";

import type {
  SlackAuthInfo,
  SlackChannel,
  SlackChannelType,
  SlackMessage,
  SlackUser,
} from "./types";

const SLACK_API_BASE_URL = "https://slack.com/api";
const DEFAULT_MAX_RETRIES = 5;
const MAX_RATE_LIMIT_RETRIES = 25;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_BUFFER_MS = 250;
const USERS_PAGE_LIMIT = 1_000;
const CHANNELS_PAGE_LIMIT = 200;
const HISTORY_PAGE_LIMIT = 200;
const REPLIES_PAGE_LIMIT = 200;

const FATAL_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "invalid_arg_name",
]);

const SKIPPABLE_CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "restricted_action",
  "is_archived",
  "thread_not_found",
]);

export type SlackErrorKind =
  | "auth"
  | "channel_access"
  | "rate_limit"
  | "api"
  | "network";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SlackClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  onRateLimit?: (method: string, retryAfterMs: number) => void;
}

interface SlackResponseMetadata {
  next_cursor?: string;
}

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: SlackResponseMetadata;
}

interface AuthTestResponse extends SlackEnvelope, SlackAuthInfo {}

interface UsersListResponse extends SlackEnvelope {
  members?: SlackUser[];
}

interface UsersInfoResponse extends SlackEnvelope {
  user?: SlackUser;
}

interface ConversationsListResponse extends SlackEnvelope {
  channels?: SlackChannel[];
}

interface ConversationsHistoryResponse extends SlackEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}

interface ConversationsRepliesResponse extends SlackEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}

export class SlackClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly onRateLimit?: (method: string, retryAfterMs: number) => void;

  constructor(options: SlackClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.onRateLimit = options.onRateLimit;
  }

  async authTest(): Promise<SlackAuthInfo> {
    const response = await this.call<AuthTestResponse>("auth.test");
    return {
      user_id: response.user_id,
      user: response.user,
      team_id: response.team_id,
      team: response.team,
      url: response.url,
    };
  }

  async listUsers(): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<UsersListResponse>("users.list", {
        limit: USERS_PAGE_LIMIT,
        cursor,
      });
      if (response.members) {
        users.push(...response.members);
      }
      cursor = nextCursor(response);
    } while (cursor);

    return users;
  }

  async getUserInfo(userId: string): Promise<SlackUser | null> {
    if (!userId || userId === "U00") {
      return null;
    }

    try {
      const response = await this.call<UsersInfoResponse>("users.info", {
        user: userId,
      });
      return response.user ?? null;
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "user_not_found") {
        return null;
      }
      throw error;
    }
  }

  async listChannels(
    types: readonly SlackChannelType[],
  ): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<ConversationsListResponse>(
        "conversations.list",
        {
          types: types.join(","),
          exclude_archived: false,
          limit: CHANNELS_PAGE_LIMIT,
          cursor,
        },
      );
      if (response.channels) {
        channels.push(...response.channels.filter((ch) => Boolean(ch.id)));
      }
      cursor = nextCursor(response);
    } while (cursor);

    return channels;
  }

  async getConversationHistory(
    channelId: string,
    oldest?: string,
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<ConversationsHistoryResponse>(
        "conversations.history",
        {
          channel: channelId,
          oldest,
          inclusive: oldest ? true : undefined,
          limit: HISTORY_PAGE_LIMIT,
          cursor,
        },
      );
      if (response.messages) {
        messages.push(...response.messages);
      }
      cursor = nextCursor(response);
    } while (cursor);

    return messages;
  }

  async getConversationReplies(
    channelId: string,
    threadTs: string,
    oldest?: string,
  ): Promise<SlackMessage[]> {
    const replies: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<ConversationsRepliesResponse>(
        "conversations.replies",
        {
          channel: channelId,
          ts: threadTs,
          oldest,
          inclusive: oldest ? true : undefined,
          limit: REPLIES_PAGE_LIMIT,
          cursor,
        },
      );
      if (response.messages) {
        for (const message of response.messages) {
          if (message.ts && message.ts !== threadTs) {
            replies.push(message);
          }
        }
      }
      cursor = nextCursor(response);
    } while (cursor);

    return replies;
  }

  private async call<T extends SlackEnvelope>(
    method: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const url = buildSlackUrl(this.baseUrl, method, params);
    let transientAttempt = 0;
    let rateLimitAttempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
        });
      } catch (error) {
        transientAttempt += 1;
        if (transientAttempt > this.maxRetries) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new SlackApiError(
            `Slack ${method} network error after ${this.maxRetries} retries: ${detail}`,
            { code: "network_error", method, kind: "network" },
          );
        }
        await this.sleepImpl(computeBackoffMs(transientAttempt));
        continue;
      }

      if (response.status === 429) {
        rateLimitAttempt += 1;
        if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) {
          throw new SlackApiError(
            `Slack ${method} exceeded max rate-limit retries (${MAX_RATE_LIMIT_RETRIES})`,
            { code: "ratelimited", method, kind: "rate_limit", status: 429 },
          );
        }
        const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));
        this.onRateLimit?.(method, waitMs);
        await this.sleepImpl(waitMs);
        continue;
      }

      if (response.status >= 500) {
        transientAttempt += 1;
        if (transientAttempt > this.maxRetries) {
          throw new SlackApiError(
            `Slack ${method} failed with HTTP ${response.status} after ${this.maxRetries} retries`,
            {
              code: `http_${response.status}`,
              method,
              kind: "network",
              status: response.status,
            },
          );
        }
        await this.sleepImpl(computeBackoffMs(transientAttempt));
        continue;
      }

      if (!response.ok) {
        throw new SlackApiError(
          `Slack ${method} failed with HTTP ${response.status}`,
          {
            code: `http_${response.status}`,
            method,
            kind: "api",
            status: response.status,
          },
        );
      }

      const payload = (await response.json()) as T;
      if (payload.ok) {
        return payload;
      }

      const errorCode = payload.error ?? "unknown_error";
      if (errorCode === "ratelimited") {
        rateLimitAttempt += 1;
        if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) {
          throw new SlackApiError(
            `Slack ${method} exceeded max rate-limit retries`,
            { code: "ratelimited", method, kind: "rate_limit" },
          );
        }
        const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));
        this.onRateLimit?.(method, waitMs);
        await this.sleepImpl(waitMs);
        continue;
      }

      const kind = classifySlackError(errorCode);
      throw new SlackApiError(`Slack ${method} error: ${errorCode}`, {
        code: errorCode,
        method,
        kind,
        status: response.status,
      });
    }
  }
}

export class SlackApiError extends Error {
  readonly code: string;
  readonly method: string;
  readonly kind: SlackErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    details: {
      code: string;
      method: string;
      kind: SlackErrorKind;
      status?: number;
    },
  ) {
    super(message);
    this.name = "SlackApiError";
    this.code = details.code;
    this.method = details.method;
    this.kind = details.kind;
    this.status = details.status;
  }
}

export function classifySlackError(code: string): SlackErrorKind {
  if (FATAL_AUTH_ERRORS.has(code)) {
    return "auth";
  }
  if (SKIPPABLE_CHANNEL_ERRORS.has(code)) {
    return "channel_access";
  }
  if (code === "ratelimited") {
    return "rate_limit";
  }
  return "api";
}

function buildSlackUrl(
  baseUrl: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`${baseUrl}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function nextCursor(envelope: SlackEnvelope): string | undefined {
  const cursor = envelope.response_metadata?.next_cursor?.trim();
  return cursor && cursor.length > 0 ? cursor : undefined;
}

function parseRetryAfterMs(header: string | null): number {
  if (header) {
    const parsedSeconds = Number.parseFloat(header);
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      return Math.ceil(parsedSeconds * 1_000) + RATE_LIMIT_BUFFER_MS;
    }
  }
  return 5_000;
}

function computeBackoffMs(attempt: number): number {
  return Math.min(DEFAULT_BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

async function defaultSleep(ms: number): Promise<void> {
  await delay(ms);
}
