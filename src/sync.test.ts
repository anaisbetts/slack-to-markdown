import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveStatePaths } from "./config";
import { parseCliCommand, runCli } from "./index";
import type { FetchLike } from "./slack-client";
import { ArchiveStore } from "./store";
import { computeHistoryOldest } from "./sync";

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
