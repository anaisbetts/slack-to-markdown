import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveChannelType,
  deriveFolderName,
  isChannelExcluded,
  loadArchiveConfig,
  matchesChannelFilter,
  parseChannelTypes,
  resolveStatePaths,
  sanitizeFolderName,
  saveArchiveExcludes,
} from "./config";
import type { SlackChannel } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("config", () => {
  test("loadArchiveConfig returns defaults when config.json does not exist", async () => {
    const dir = await createTempDir();
    const config = await loadArchiveConfig(dir);

    expect(config.exclude).toEqual([]);
    expect(config.channelTypes).toEqual([
      "public_channel",
      "private_channel",
      "mpim",
      "im",
    ]);
    expect(config.lookbackDays).toBe(14);
  });

  test("loadArchiveConfig merges config.json with CLI overrides and dedupes excludes", async () => {
    const dir = await createTempDir();
    const { stateDir, configPath } = resolveStatePaths(dir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        exclude: ["house-debug", "dont-talk-in-here"],
        channelTypes: ["public_channel", "im"],
        lookbackDays: 21,
      }),
      "utf-8",
    );

    const config = await loadArchiveConfig(dir, {
      exclude: ["HOUSE-DEBUG", "cadwallion (cadwallion)"],
      lookbackDays: 7,
    });

    expect(config.exclude).toEqual([
      "house-debug",
      "dont-talk-in-here",
      "cadwallion (cadwallion)",
    ]);
    expect(config.channelTypes).toEqual(["public_channel", "im"]);
    expect(config.lookbackDays).toBe(7);
  });

  test("saveArchiveExcludes writes config.json and preserves existing fields", async () => {
    const dir = await createTempDir();
    const { stateDir, configPath } = resolveStatePaths(dir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ lookbackDays: 30, exclude: ["house-debug"] }),
      "utf-8",
    );

    const savedPath = await saveArchiveExcludes(dir, [
      "HOUSE-DEBUG",
      "dont-talk-in-here",
      "cadwallion (cadwallion)",
    ]);
    expect(savedPath).toBe(configPath);

    const loaded = await loadArchiveConfig(dir);
    expect(loaded.lookbackDays).toBe(30);
    expect(loaded.exclude).toEqual([
      "house-debug",
      "dont-talk-in-here",
      "cadwallion (cadwallion)",
    ]);
  });

  test("loadArchiveConfig rejects invalid JSON or bad field types", async () => {
    const dir = await createTempDir();
    const { stateDir, configPath } = resolveStatePaths(dir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(configPath, "{not valid json", "utf-8");

    await expect(loadArchiveConfig(dir)).rejects.toThrow("Invalid JSON");

    await writeFile(configPath, JSON.stringify({ lookbackDays: -3 }), "utf-8");
    await expect(loadArchiveConfig(dir)).rejects.toThrow(
      "non-negative integer",
    );
  });

  test("isChannelExcluded matches by ID, Slack name, or folder name case-insensitively", () => {
    const identity = {
      id: "D12345",
      slackName: "cadwallion",
      folderName: "cadwallion (cadwallion)",
    };

    expect(isChannelExcluded(identity, ["d12345"])).toBe(true);
    expect(isChannelExcluded(identity, ["CADWALLION"])).toBe(true);
    expect(isChannelExcluded(identity, ["cadwallion (cadwallion)"])).toBe(true);
    expect(isChannelExcluded(identity, ["house-debug"])).toBe(false);
  });

  test("matchesChannelFilter matches exact ID or names", () => {
    const identity = {
      id: "C01",
      slackName: "general",
      folderName: "general",
    };

    expect(matchesChannelFilter(identity, undefined)).toBe(true);
    expect(matchesChannelFilter(identity, "C01")).toBe(true);
    expect(matchesChannelFilter(identity, "GENERAL")).toBe(true);
    expect(matchesChannelFilter(identity, "random")).toBe(false);
  });

  test("deriveFolderName matches slack-archive naming for channels, DMs, and MPIMs", () => {
    const users = new Map([
      [
        "U1",
        {
          id: "U1",
          name: "alice",
          realName: "Alice Smith",
          displayName: "Alice",
        },
      ],
    ]);

    const pub: SlackChannel = { id: "C1", name: "451-kansas" };
    const dm: SlackChannel = { id: "D1", is_im: true, user: "U1" };
    const mpim: SlackChannel = {
      id: "G1",
      is_mpim: true,
      purpose: { value: "Group messaging with: @alice @bob" },
    };

    expect(deriveChannelType(pub)).toBe("public_channel");
    expect(deriveChannelType(dm)).toBe("im");
    expect(deriveChannelType(mpim)).toBe("mpim");

    expect(deriveFolderName(pub, users)).toBe("451-kansas");
    expect(deriveFolderName(dm, users)).toBe("Alice (alice)");
    expect(deriveFolderName(mpim, users)).toBe(
      "Group messaging with: alice bob",
    );
  });

  test("sanitizeFolderName strips path separators, control chars, and dot-only names", () => {
    expect(sanitizeFolderName("foo/bar\\baz")).toBe("foo-bar-baz");
    expect(sanitizeFolderName("  hello\t  world  ")).toBe("hello world");
    expect(sanitizeFolderName("..")).toBe("unknown-channel");
  });

  test("parseChannelTypes validates and deduplicates channel types", () => {
    expect(parseChannelTypes("public_channel, im, public_channel")).toEqual([
      "public_channel",
      "im",
    ]);
    expect(() => parseChannelTypes("bogus")).toThrow("Invalid channel type");
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slack-to-md-config-"));
  tempDirs.push(dir);
  return dir;
}
