import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadArchiveConfig, resolveStatePaths } from "./config";
import { runCli } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("seedFromSlackArchive", () => {
  test("imports slack-archive JSON, flattens nested replies, respects exclusions, and preserves summaries", async () => {
    const seedDir = await createTempDir();
    const outDir = await createTempDir();

    await writeFile(
      path.join(seedDir, "users.json"),
      JSON.stringify({
        U1: { id: "U1", name: "alice", real_name: "Alice Smith" },
        U2: { id: "U2", name: "bob", real_name: "Bob Jones" },
      }),
      "utf-8",
    );

    await writeFile(
      path.join(seedDir, "channels.json"),
      JSON.stringify([
        { id: "C1", name: "general", is_channel: true },
        { id: "C2", name: "house-debug", is_channel: true },
        {
          id: "G1",
          is_mpim: true,
          purpose: { value: "Group messaging with: @alice @bob" },
        },
      ]),
      "utf-8",
    );

    // 2026-11-18T10:00:00Z = 1794996000, reply on 2026-11-19T11:05:00Z = 1795086300
    await writeFile(
      path.join(seedDir, "C1.json"),
      JSON.stringify([
        {
          ts: "1794996000.000100",
          user: "U1",
          text: "Hello <@U2|bob>!",
          reply_count: 1,
          replies: [
            {
              ts: "1795086300.000200",
              user: "U2",
              text: "Hey back next day!",
            },
          ],
        },
      ]),
      "utf-8",
    );

    await writeFile(
      path.join(seedDir, "C2.json"),
      JSON.stringify([
        { ts: "1794996000.000100", user: "U1", text: "noisy debug log" },
      ]),
      "utf-8",
    );

    // Pre-existing summary file in output dir must survive untouched
    await mkdir(path.join(outDir, "general"), { recursive: true });
    await writeFile(
      path.join(outDir, "general", "2026-11.txt"),
      "November 2026 summary",
      "utf-8",
    );

    const logs: string[] = [];
    await runCli({
      argv: [
        outDir,
        "--seed-from",
        seedDir,
        "--render-only",
        "--excludes",
        "house-debug,dont-talk-in-here",
      ],
      log: (line) => logs.push(line),
    });

    // Excludes passed with --seed-from are persisted into config.json
    const { configPath } = resolveStatePaths(outDir);
    const savedConfig = JSON.parse(await readFile(configPath, "utf-8"));
    expect(savedConfig).toEqual({
      exclude: ["house-debug", "dont-talk-in-here"],
    });
    const reloadedConfig = await loadArchiveConfig(outDir);
    expect(reloadedConfig.exclude).toEqual([
      "house-debug",
      "dont-talk-in-here",
    ]);

    const day1 = await readFile(
      path.join(outDir, "general", "2026-11-18.txt"),
      "utf-8",
    );
    expect(day1).toContain("a: Hello Bob Jones!");

    const day2 = await readFile(
      path.join(outDir, "general", "2026-11-19.txt"),
      "utf-8",
    );
    expect(day2).toContain(
      '[Thread from 2026-11-18 by Alice Smith: "Hello Bob Jones!"]',
    );
    expect(day2).toContain("  > b: Hey back next day!");

    // Summary untouched
    expect(
      await readFile(path.join(outDir, "general", "2026-11.txt"), "utf-8"),
    ).toBe("November 2026 summary");

    // Excluded channel was not written
    await expect(
      readFile(path.join(outDir, "house-debug", "2026-11-18.txt"), "utf-8"),
    ).rejects.toThrow();
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slack-to-md-seed-"));
  tempDirs.push(dir);
  return dir;
}
