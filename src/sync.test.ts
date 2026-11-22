import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveStatePaths } from "./config";
import { parseCliCommand, runCli } from "./index";
import type { FetchLike } from "./slack-client";
import { ArchiveStore } from "./store";
import {
  computeHistoryOldest,
  shouldPollChannelInFastMode,
  shouldRunFullScan,
} from "./sync";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("syncWorkspace & CLI", () => {
  test("computeHistoryOldest uses min(lastMessageTs, now - lookbackDays)", () => {
    const nowSec = 1_800_000_000;
    const nowMs = nowSec * 1_000;
    const oneDayAgo = String(nowSec - 86_400);
    const sixtyDaysAgo = String(nowSec - 60 * 86_400);

    // Recent channel looks back 14 days
    expect(computeHistoryOldest(oneDayAgo, 14, nowMs)).toBe(
      String(nowSec - 14 * 86_400),
    );
    // Dormant channel stays at its last message ts
    expect(computeHistoryOldest(sixtyDaysAgo, 14, nowMs)).toBe(sixtyDaysAgo);
    // Never-synced channel fetches full history
    expect(computeHistoryOldest(null, 14, nowMs)).toBeUndefined();
  });

  test("performs incremental sync with 14-day lookback, catches cross-day thread replies, skips archived/excluded, and handles per-channel errors", async () => {
    const outDir = await createTempDir();

    // Day 1: 2026-11-10T10:00:00Z = 1794304800
    const day1Ts = "1794304800.000100";
    // Day 3 (run 2): 2026-11-12T15:20:00Z = 1794496800
    const day3ReplyTs = "1794496800.000200";
    const run1NowMs = 1794310000 * 1_000;
    const run2NowMs = 1794500000 * 1_000;

    let runPhase = 1;
    const historyCalls: Array<{ channel: string; oldest: string | null }> = [];
    const repliesCalls: string[] = [];

    const fetchMock: FetchLike = async (input) => {
      const url = new URL(String(input));
      const method = url.pathname.split("/").pop();

      if (method === "auth.test") {
        return jsonResponse({
          ok: true,
          user_id: "U_ANI",
          user: "ani",
          team_id: "T_HOME",
          team: "myteam",
        });
      }

      if (method === "users.list") {
        return jsonResponse({
          ok: true,
          members: [{ id: "U1", name: "alice", real_name: "Alice Smith" }],
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "users.info") {
        const userId = url.searchParams.get("user");
        if (userId === "U_EXT") {
          return jsonResponse({
            ok: true,
            user: { id: "U_EXT", name: "ext", real_name: "External Guest" },
          });
        }
        return jsonResponse({ ok: false, error: "user_not_found" });
      }

      if (method === "conversations.list") {
        return jsonResponse({
          ok: true,
          channels: [
            { id: "C1", name: "general", is_channel: true },
            {
              id: "C_ARCH",
              name: "old-room",
              is_channel: true,
              is_archived: true,
            },
            { id: "C_EXCL", name: "house-debug", is_channel: true },
            { id: "C_ERR", name: "secret", is_private: true },
          ],
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "conversations.history") {
        const channel = url.searchParams.get("channel") ?? "";
        const oldest = url.searchParams.get("oldest");
        historyCalls.push({ channel, oldest });

        if (channel === "C_ERR") {
          return jsonResponse({ ok: false, error: "not_in_channel" });
        }

        if (channel === "C_ARCH") {
          return jsonResponse({
            ok: true,
            messages: [{ ts: day1Ts, user: "U1", text: "Archived goodbye" }],
            response_metadata: { next_cursor: "" },
          });
        }

        if (channel === "C1") {
          if (runPhase === 1) {
            return jsonResponse({
              ok: true,
              messages: [
                {
                  ts: day1Ts,
                  user: "U1",
                  text: "Initial thread post",
                  reply_count: 0,
                },
              ],
              response_metadata: { next_cursor: "" },
            });
          }
          // Run 2: lookback surfaces parent with reply_count=1
          return jsonResponse({
            ok: true,
            messages: [
              {
                ts: day1Ts,
                user: "U1",
                text: "Initial thread post",
                reply_count: 1,
                latest_reply: day3ReplyTs,
              },
            ],
            response_metadata: { next_cursor: "" },
          });
        }
      }

      if (method === "client.counts") {
        return jsonResponse({
          ok: true,
          channels: [{ id: "C1", latest: day1Ts }],
          mpims: [],
          ims: [],
        });
      }

      if (method === "search.messages") {
        return jsonResponse({
          ok: true,
          messages: {
            matches: [{ ts: day3ReplyTs, channel: { id: "C1" } }],
            paging: { page: 1, pages: 1 },
          },
        });
      }

      if (method === "conversations.replies") {
        const ts = url.searchParams.get("ts") ?? "";
        repliesCalls.push(ts);
        return jsonResponse({
          ok: true,
          messages: [
            { ts: day1Ts, user: "U1", text: "Initial thread post" },
            {
              ts: day3ReplyTs,
              thread_ts: day1Ts,
              user: "U_EXT",
              text: "Late reply from external user",
            },
          ],
          response_metadata: { next_cursor: "" },
        });
      }

      throw new Error(`Unexpected method: ${method}`);
    };

    // Run 1: initial sync
    await runCli({
      argv: [outDir, "--exclude", "house-debug"],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: run1NowMs,
      log: () => {},
    });

    expect(historyCalls.map((c) => c.channel)).toEqual([
      "C1",
      "C_ARCH",
      "C_ERR",
    ]);
    expect(repliesCalls).toEqual([]);

    const day1Path = path.join(outDir, "general", "2026-11-10.txt");
    const day1StatBefore = await stat(day1Path);
    expect(await readFile(day1Path, "utf-8")).toContain(
      "a: Initial thread post",
    );
    expect(
      await readFile(path.join(outDir, "old-room", "2026-11-10.txt"), "utf-8"),
    ).toContain("a: Archived goodbye");

    // Run 2: incremental sync
    runPhase = 2;
    historyCalls.length = 0;

    await runCli({
      argv: [outDir, "--exclude", "house-debug"],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: run2NowMs,
      log: () => {},
    });

    // Archived channel C_ARCH was skipped on run 2!
    expect(historyCalls.map((c) => c.channel)).toEqual(["C1", "C_ERR"]);
    // Lookback fetched updated thread replies once
    expect(repliesCalls).toEqual([day1Ts]);

    // Day 1 file was NOT rewritten (mtime unchanged)
    const day1StatAfter = await stat(day1Path);
    expect(day1StatAfter.mtimeMs).toBe(day1StatBefore.mtimeMs);

    // Day 3 file was written with parent context and resolved external user name
    const day3Content = await readFile(
      path.join(outDir, "general", "2026-11-12.txt"),
      "utf-8",
    );
    expect(day3Content).toContain("e - External Guest");
    expect(day3Content).toContain(
      '[Thread from 2026-11-10 by Alice Smith: "Initial thread post"]',
    );
    expect(day3Content).toContain("  > e: Late reply from external user");
  });

  test("saves token & user in SQLite, allows same-user token rotation, reuses saved token, and blows up on user mismatch", async () => {
    const outDir = await createTempDir();
    let usersListCalls = 0;

    const fetchMock: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const method = url.pathname.split("/").pop();
      const authHeader =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        "";
      const token = authHeader.replace(/^Bearer\s+/i, "");

      if (method === "auth.test") {
        if (token === "xoxp-user1-v1" || token === "xoxp-user1-v2") {
          return jsonResponse({
            ok: true,
            user_id: "U_USER1",
            user: "alice",
            team_id: "T_TEAM1",
            team: "team1",
          });
        }
        if (token === "xoxp-user2") {
          return jsonResponse({
            ok: true,
            user_id: "U_USER2",
            user: "bob",
            team_id: "T_TEAM1",
            team: "team1",
          });
        }
        return jsonResponse({ ok: false, error: "invalid_auth" });
      }

      if (method === "users.list") {
        usersListCalls += 1;
        return jsonResponse({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "conversations.list") {
        return jsonResponse({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "client.counts") {
        return jsonResponse({ ok: true, channels: [], mpims: [], ims: [] });
      }

      if (method === "search.messages") {
        return jsonResponse({
          ok: true,
          messages: {
            matches: [],
            paging: { page: 1, pages: 1 },
          },
        });
      }

      throw new Error(`Unexpected method: ${method}`);
    };

    // 1. First run saves token + user identity in SQLite
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-user1-v1" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      log: () => {},
    });

    const { dbPath } = resolveStatePaths(outDir);
    let store = new ArchiveStore(dbPath);
    expect(store.getSavedAuth()).toEqual({
      token: "xoxp-user1-v1",
      userId: "U_USER1",
      user: "alice",
      teamId: "T_TEAM1",
      team: "team1",
    });
    store.close();

    // 2. Subsequent run without SLACK_TOKEN reuses saved token from SQLite
    await runCli({
      argv: [outDir],
      env: {},
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      log: () => {},
    });
    expect(usersListCalls).toBe(2);

    // 3. Different token for the SAME user succeeds and updates saved token
    const rotationLogs: string[] = [];
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-user1-v2" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      log: (line) => rotationLogs.push(line),
    });
    expect(rotationLogs.some((l) => l.includes("Updating saved token"))).toBe(
      true,
    );

    store = new ArchiveStore(dbPath);
    expect(store.getSavedAuth()?.token).toBe("xoxp-user1-v2");
    store.close();

    // 4. Different token for a DIFFERENT user blows up before touching Slack data or SQLite
    const callsBeforeMismatch = usersListCalls;
    await expect(
      runCli({
        argv: [outDir],
        env: { SLACK_TOKEN: "xoxp-user2" },
        fetchImpl: fetchMock,
        sleepImpl: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow("Slack token user mismatch");
    expect(usersListCalls).toBe(callsBeforeMismatch);

    store = new ArchiveStore(dbPath);
    expect(store.getSavedAuth()?.token).toBe("xoxp-user1-v2");
    expect(store.getSavedAuth()?.userId).toBe("U_USER1");
    store.close();
  });

  test("fast scan uses client.counts + search.messages + active window, skips dormant channels, runs weekly full scan, and falls back only when both fail", async () => {
    const outDir = await createTempDir();
    const day0Ms = Date.parse("2026-11-01T12:00:00Z");
    const day2Ms = Date.parse("2026-11-03T12:00:00Z");
    const day9Ms = Date.parse("2026-11-10T12:00:00Z");
    const oldMsgTs = String(
      Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1_000),
    );
    const recentMsgTs = String(
      Math.floor(Date.parse("2026-10-30T12:00:00Z") / 1_000),
    );
    const wokeMsgTs = String(
      Math.floor(Date.parse("2026-11-03T11:00:00Z") / 1_000),
    );

    let phase: "initial" | "fast" | "counts_only" | "weekly" | "both_denied" =
      "initial";
    const polledChannels: string[] = [];
    let searchCalls = 0;
    let countsCalls = 0;

    const fetchMock: FetchLike = async (input) => {
      const url = new URL(String(input));
      const method = url.pathname.split("/").pop();

      if (method === "auth.test") {
        return jsonResponse({
          ok: true,
          user_id: "U1",
          user: "ani",
          team_id: "T1",
          team: "home",
        });
      }

      if (method === "users.list") {
        return jsonResponse({
          ok: true,
          members: [{ id: "U1", name: "ani", real_name: "Anais" }],
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "conversations.list") {
        const channels = [
          { id: "C_ACTIVE", name: "active", is_channel: true },
          { id: "C_DORMANT", name: "dormant", is_channel: true },
          { id: "C_WOKE_SEARCH", name: "woke-search", is_im: true, user: "U1" },
          { id: "C_WOKE_COUNTS", name: "woke-counts", is_im: true, user: "U1" },
        ];
        if (phase === "fast") {
          channels.push({ id: "C_NEW", name: "brand-new", is_channel: true });
        }
        return jsonResponse({
          ok: true,
          channels,
          response_metadata: { next_cursor: "" },
        });
      }

      if (method === "client.counts") {
        countsCalls += 1;
        if (phase === "both_denied") {
          return jsonResponse({ ok: false, error: "not_allowed_token_type" });
        }
        return jsonResponse({
          ok: true,
          channels: [
            { id: "C_ACTIVE", latest: recentMsgTs },
            { id: "C_DORMANT", latest: oldMsgTs },
          ],
          mpims: [],
          ims: [
            { id: "C_WOKE_SEARCH", latest: oldMsgTs },
            {
              id: "C_WOKE_COUNTS",
              latest:
                phase === "fast" || phase === "counts_only"
                  ? wokeMsgTs
                  : oldMsgTs,
            },
          ],
        });
      }

      if (method === "search.messages") {
        searchCalls += 1;
        if (phase === "counts_only" || phase === "both_denied") {
          return jsonResponse({ ok: false, error: "missing_scope" });
        }
        return jsonResponse({
          ok: true,
          messages: {
            matches: [{ ts: wokeMsgTs, channel: { id: "C_WOKE_SEARCH" } }],
            paging: { page: 1, pages: 1 },
          },
        });
      }

      if (method === "conversations.history") {
        const channel = url.searchParams.get("channel") ?? "";
        polledChannels.push(channel);
        if (channel === "C_ACTIVE") {
          return jsonResponse({
            ok: true,
            messages: [{ ts: recentMsgTs, user: "U1", text: "active chat" }],
          });
        }
        if (channel === "C_DORMANT") {
          return jsonResponse({
            ok: true,
            messages: [{ ts: oldMsgTs, user: "U1", text: "old message" }],
          });
        }
        if (channel === "C_WOKE_SEARCH" || channel === "C_WOKE_COUNTS") {
          return jsonResponse({
            ok: true,
            messages:
              phase === "initial"
                ? [{ ts: oldMsgTs, user: "U1", text: "ancient dm" }]
                : [{ ts: wokeMsgTs, user: "U1", text: "woke up!" }],
          });
        }
        return jsonResponse({ ok: true, messages: [] });
      }

      throw new Error(`Unexpected method: ${method}`);
    };

    // 1. Initial run has no last_full_scan_at -> runs full scan
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: day0Ms,
      log: () => {},
    });
    expect(polledChannels).toEqual([
      "C_ACTIVE",
      "C_DORMANT",
      "C_WOKE_SEARCH",
      "C_WOKE_COUNTS",
    ]);
    expect(searchCalls).toBe(0);
    expect(countsCalls).toBe(0);

    // 2. Two days later -> fast scan via client.counts + search.messages:
    //    skips C_DORMANT, polls C_ACTIVE (active window), C_WOKE_SEARCH (search), C_WOKE_COUNTS (client.counts), and C_NEW (never synced)
    phase = "fast";
    polledChannels.length = 0;
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: day2Ms,
      log: () => {},
    });
    expect(countsCalls).toBe(1);
    expect(searchCalls).toBe(1);
    expect(polledChannels).toEqual([
      "C_ACTIVE",
      "C_WOKE_SEARCH",
      "C_WOKE_COUNTS",
      "C_NEW",
    ]);

    // 3. Even if search.messages fails, client.counts alone still keeps fast scan active (C_DORMANT stays skipped)
    phase = "counts_only";
    polledChannels.length = 0;
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: day2Ms + 3_600_000,
      log: () => {},
    });
    expect(polledChannels).toEqual([
      "C_ACTIVE",
      "C_WOKE_SEARCH",
      "C_WOKE_COUNTS",
    ]);

    // 4. Nine days after initial full scan (> 7d) -> weekly full scan sweeps C_DORMANT again
    phase = "weekly";
    polledChannels.length = 0;
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: day9Ms,
      log: () => {},
    });
    expect(polledChannels).toEqual([
      "C_ACTIVE",
      "C_DORMANT",
      "C_WOKE_SEARCH",
      "C_WOKE_COUNTS",
    ]);

    // 5. If BOTH client.counts and search.messages fail -> falls back to full scan
    phase = "both_denied";
    polledChannels.length = 0;
    const fallbackLogs: string[] = [];
    await runCli({
      argv: [outDir],
      env: { SLACK_TOKEN: "xoxp-test" },
      fetchImpl: fetchMock,
      sleepImpl: async () => {},
      nowMs: day9Ms + 86_400_000,
      log: (line) => fallbackLogs.push(line),
    });
    expect(polledChannels).toEqual([
      "C_ACTIVE",
      "C_DORMANT",
      "C_WOKE_SEARCH",
      "C_WOKE_COUNTS",
    ]);
    expect(
      fallbackLogs.some((l) => l.includes("falling back to full scan")),
    ).toBe(true);

    // Unit checks on pure scheduling helpers
    expect(shouldRunFullScan(null, false, 7, day0Ms)).toBe(true);
    expect(
      shouldRunFullScan(new Date(day0Ms).toISOString(), false, 7, day2Ms),
    ).toBe(false);
    expect(
      shouldRunFullScan(new Date(day0Ms).toISOString(), true, 7, day2Ms),
    ).toBe(true);
    expect(
      shouldRunFullScan(new Date(day0Ms).toISOString(), false, 7, day9Ms),
    ).toBe(true);
    expect(
      shouldPollChannelInFastMode(
        {
          id: "C_X",
          type: "public_channel",
          slackName: "x",
          folderName: "x",
          purpose: "",
          isArchived: false,
          isUserDeleted: false,
          dmUserId: null,
          fullySynced: false,
          lastMessageTs: oldMsgTs,
          lastSyncedAt: day0Ms,
          rawJson: "{}",
        },
        new Set(),
        new Map([["C_X", oldMsgTs]]),
        30,
        day2Ms,
      ),
    ).toBe(false);
    expect(
      shouldPollChannelInFastMode(
        {
          id: "C_X",
          type: "public_channel",
          slackName: "x",
          folderName: "x",
          purpose: "",
          isArchived: false,
          isUserDeleted: false,
          dmUserId: null,
          fullySynced: false,
          lastMessageTs: oldMsgTs,
          lastSyncedAt: day0Ms,
          rawJson: "{}",
        },
        new Set(),
        new Map([["C_X", wokeMsgTs]]),
        30,
        day2Ms,
      ),
    ).toBe(true);
  });

  test("CLI parsing handles --help and fails fast without token", async () => {
    const help = parseCliCommand(["--help"]);
    expect(help.kind).toBe("help");

    const dir = await createTempDir();
    await expect(
      runCli({
        argv: [dir],
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow("Missing Slack token");
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slack-to-md-sync-"));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
