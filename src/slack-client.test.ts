import { describe, expect, test } from "bun:test";

import {
  classifySlackError,
  type FetchLike,
  SlackApiError,
  SlackClient,
} from "./slack-client";

describe("SlackClient", () => {
  test("paginates users.list and excludes parent message in conversations.replies", async () => {
    const calls: string[] = [];
    const fetchMock: FetchLike = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users.list")) {
        const cursor = url.searchParams.get("cursor");
        if (!cursor) {
          return jsonResponse({
            ok: true,
            members: [{ id: "U1", name: "alice" }],
            response_metadata: { next_cursor: "page2" },
          });
        }
        return jsonResponse({
          ok: true,
          members: [{ id: "U2", name: "bob" }],
          response_metadata: { next_cursor: "" },
        });
      }

      if (url.pathname.endsWith("/conversations.replies")) {
        return jsonResponse({
          ok: true,
          messages: [
            { ts: "100.0", text: "parent" },
            { ts: "101.0", thread_ts: "100.0", text: "reply 1" },
            { ts: "102.0", thread_ts: "100.0", text: "reply 2" },
          ],
          response_metadata: { next_cursor: "" },
        });
      }

      if (url.pathname.endsWith("/search.messages")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        if (page === 1) {
          return jsonResponse({
            ok: true,
            messages: {
              matches: [
                { ts: "200.0", channel: { id: "C_HOT" } },
                { ts: "150.0", channel: { id: "D_WOKE" } },
              ],
              paging: { page: 1, pages: 2 },
            },
          });
        }
        return jsonResponse({
          ok: true,
          messages: {
            matches: [{ ts: "50.0", channel: { id: "C_OLD" } }],
            paging: { page: 2, pages: 2 },
          },
        });
      }

      throw new Error(`Unexpected URL: ${url.toString()}`);
    };

    const client = new SlackClient({
      token: "xoxp-test",
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    });

    const users = await client.listUsers();
    expect(users.map((u) => u.id)).toEqual(["U1", "U2"]);

    const replies = await client.getConversationReplies("C1", "100.0");
    expect(replies.map((r) => r.ts)).toEqual(["101.0", "102.0"]);

    const active = await client.searchActiveChannelIds("2026-11-20", 100);
    expect(Array.from(active).sort()).toEqual(["C_HOT", "C_OLD", "D_WOKE"]);
    expect(calls.length).toBe(5);
  });

  test("retries HTTP 429 using Retry-After header and recovers from transient 502", async () => {
    const sleeps: number[] = [];
    const rateLimitEvents: Array<{ method: string; ms: number }> = [];
    let attempt = 0;

    const fetchMock: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      }
      if (attempt === 2) {
        return new Response("bad gateway", { status: 502 });
      }
      return jsonResponse({ ok: true, user: "ani", team: "home" });
    };

    const client = new SlackClient({
      token: "xoxp-test",
      fetchImpl: fetchMock,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      onRateLimit: (method, ms) => {
        rateLimitEvents.push({ method, ms });
      },
    });

    const auth = await client.authTest();
    expect(auth.user).toBe("ani");
    expect(attempt).toBe(3);
    expect(rateLimitEvents).toEqual([{ method: "auth.test", ms: 2250 }]);
    expect(sleeps).toEqual([2250, 1000]);
  });

  test("classifies Slack errors and returns null for user_not_found", async () => {
    expect(classifySlackError("invalid_auth")).toBe("auth");
    expect(classifySlackError("not_in_channel")).toBe("channel_access");
    expect(classifySlackError("ratelimited")).toBe("rate_limit");
    expect(classifySlackError("something_else")).toBe("api");

    const fetchMock: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/users.info")) {
        return jsonResponse({ ok: false, error: "user_not_found" });
      }
      return jsonResponse({ ok: false, error: "invalid_auth" });
    };

    const client = new SlackClient({
      token: "xoxp-bad",
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
    });

    expect(await client.getUserInfo("U404")).toBeNull();

    try {
      await client.authTest();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SlackApiError);
      expect((error as SlackApiError).kind).toBe("auth");
    }
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
