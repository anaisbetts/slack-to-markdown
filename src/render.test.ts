import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAbbreviationMap,
  renderDayContent,
  renderDirtyDays,
  resolveSlackMarkup,
} from "./render";
import { ArchiveStore } from "./store";
import type { StoredChannel, StoredUser } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("render", () => {
  test("resolveSlackMarkup cleans user/channel mentions, links, special tokens, and HTML entities", () => {
    const users = new Map<string, StoredUser>([
      [
        "U1",
        {
          id: "U1",
          name: "alice",
          realName: "Alice Smith",
          displayName: "alice",
          isBot: false,
          deleted: false,
          rawJson: "{}",
          updatedAt: 0,
        },
      ],
    ]);
    const channels = new Map<string, StoredChannel>([
      [
        "C1",
        {
          id: "C1",
          type: "public_channel",
          slackName: "engineering",
          folderName: "engineering",
          purpose: "",
          isArchived: false,
          isUserDeleted: false,
          dmUserId: null,
          fullySynced: false,
          lastMessageTs: null,
          lastSyncedAt: null,
          rawJson: "{}",
        },
      ],
    ]);

    const input =
      "Hey <@U1|alice> and <@U2|guest>, check <#C1|eng> &amp; <https://example.com|Example> + <https://same.io|https://same.io> <!here> 1 &lt; 2 &gt; 0";
    const output = resolveSlackMarkup(input, { users, channels });

    expect(output).toBe(
      "Hey Alice Smith and @guest, check #engineering & [Example](https://example.com) + https://same.io @here 1 < 2 > 0",
    );
  });

  test("buildAbbreviationMap resolves prefix collisions and identical first words", () => {
    const map = buildAbbreviationMap([
      { key: "U1", name: "Alice Smith" },
      { key: "U2", name: "Alex Jones" },
      { key: "U3", name: "Alex Brown" },
      { key: "U4", name: "Bob Lee" },
    ]);

    expect(map.get("U1")).toBe("ali");
    expect(map.get("U2")).toBe("alex1");
    expect(map.get("U3")).toBe("alex2");
    expect(map.get("U4")).toBe("b");
  });

  test("nests same-day thread replies under parent and renders cross-day replies with parent context", () => {
    const store = new ArchiveStore(":memory:");
    try {
      store.upsertUsers([
        { id: "U1", name: "alice", real_name: "Alice Smith" },
        { id: "U2", name: "bob", real_name: "Bob Jones" },
      ]);
      store.upsertChannel({ id: "C1", name: "dev" }, "public_channel", "dev");

      // Day 1: 2026-11-18T14:22:00Z = 1795011720
      const day1ParentTs = "1795011720.000100";
      // Same day reply: 2026-11-18T15:05:00Z = 1795014300
      const day1ReplyTs = "1795014300.000200";
      // Day 2 cross-day reply: 2026-11-20T09:14:00Z = 1795166040
      const day2ReplyTs = "1795166040.000300";

      store.upsertMessages("C1", [
        {
          ts: day1ParentTs,
          user: "U1",
          text: "Should we switch to bun:sqlite?",
          reply_count: 2,
          latest_reply: day2ReplyTs,
        },
        {
          ts: day1ReplyTs,
          thread_ts: day1ParentTs,
          user: "U2",
          text: "Yes, zero dependencies!",
        },
        {
          ts: day2ReplyTs,
          thread_ts: day1ParentTs,
          user: "U1",
          text: "Shipped it today.",
        },
      ]);

      const context = {
        users: store.getUserMap(),
        channels: new Map([["C1", store.getChannel("C1") as StoredChannel]]),
      };

      const day1Rendered = renderDayContent(
        store.getMessagesForDay("C1", "2026-11-18"),
        new Map(),
        context,
      );
      expect(day1Rendered).toBe(
        [
          "Users:",
          "a - Alice Smith",
          "b - Bob Jones",
          "",
          "14:20",
          "a: Should we switch to bun:sqlite?",
          "  > b: Yes, zero dependencies!",
          "",
        ].join("\n"),
      );

      const day2Messages = store.getMessagesForDay("C1", "2026-11-20");
      const parents = store.getMessagesByTs("C1", [day1ParentTs]);
      const day2Rendered = renderDayContent(day2Messages, parents, context);

      expect(day2Rendered).toBe(
        [
          "Users:",
          "a - Alice Smith",
          "",
          "09:10",
          '[Thread from 2026-11-18 by Alice Smith: "Should we switch to bun:sqlite?"]',
          "  > a: Shipped it today.",
          "",
        ].join("\n"),
      );
    } finally {
      store.close();
    }
  });

  test("renders files and attachments when text is empty, filters noise subtypes, and keeps summaries untouched", async () => {
    const dir = await createTempDir();
    const channelDir = path.join(dir, "general");
    await mkdir(channelDir, { recursive: true });
    const summaryPath = path.join(channelDir, "2026-11.txt");
    const manifestPath = path.join(channelDir, ".monthly-summaries.json");
    await writeFile(summaryPath, "Existing monthly summary", "utf-8");
    await writeFile(manifestPath, '{"2026-11": "abc"}', "utf-8");

    const store = new ArchiveStore(":memory:");
    try {
      store.upsertUsers([{ id: "U1", name: "ani", real_name: "Anais" }]);
      store.upsertChannel(
        { id: "C1", name: "general" },
        "public_channel",
        "general",
      );

      // 2026-11-20T10:01:00Z = 1795168860
      store.upsertMessages("C1", [
        {
          ts: "1795168860.000100",
          user: "U1",
          subtype: "channel_join",
          text: "<@U1> has joined the channel",
        },
        {
          ts: "1795168861.000100",
          user: "U1",
          text: "",
          files: [{ name: "diagram.png", title: "Architecture" }],
        },
        {
          ts: "1795168861.500100",
          user: "U1",
          text: "<@U1> uploaded a file: <https://slack.com/files/photo.jpg|Vacation Photo>",
          files: [{ name: "photo.jpg", title: "Vacation Photo" }],
        },
        {
          ts: "1795168862.000100",
          username: "GitHub",
          subtype: "bot_message",
          text: "",
          attachments: [
            {
              title: "PR #42 merged",
              title_link: "https://github.com/org/repo/pull/42",
              text: "Adds incremental sync",
            },
          ],
        },
      ]);

      const stats = await renderDirtyDays(store, dir);
      expect(stats.filesWritten).toBe(1);
      expect(store.getDirtyDays()).toEqual([]);

      const content = await readFile(
        path.join(channelDir, "2026-11-20.txt"),
        "utf-8",
      );
      expect(content).toContain("a: [file: Architecture (diagram.png)]");
      expect(content).toContain(
        "a: Anais uploaded a file: [Vacation Photo](https://slack.com/files/photo.jpg)",
      );
      expect(content).not.toContain("[file: Vacation Photo");
      expect(content).toContain(
        "g: [attachment: [PR #42 merged](https://github.com/org/repo/pull/42) — Adds incremental sync]",
      );
      expect(content).not.toContain("has joined the channel");

      // Preserved files remain untouched
      expect(await readFile(summaryPath, "utf-8")).toBe(
        "Existing monthly summary",
      );
      expect(await readFile(manifestPath, "utf-8")).toBe('{"2026-11": "abc"}');
    } finally {
      store.close();
    }
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slack-to-md-render-"));
  tempDirs.push(dir);
  return dir;
}
