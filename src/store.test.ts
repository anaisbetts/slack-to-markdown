import { describe, expect, test } from "bun:test";

import { ArchiveStore, pickNewerTs, slackTsToUtcDay } from "./store";

describe("ArchiveStore", () => {
  test("pins folder_name on subsequent channel updates and disambiguates collisions", () => {
    const store = new ArchiveStore(":memory:");
    try {
      const first = store.upsertChannel(
        { id: "D1", is_im: true, user: "U1" },
        "im",
        "Alice (alice)",
      );
      expect(first.folderName).toBe("Alice (alice)");

      // User changes display name to add (OOO) -> pinned folder stays unchanged
      const updated = store.upsertChannel(
        { id: "D1", is_im: true, user: "U1", is_archived: true },
        "im",
        "Alice OOO (alice)",
      );
      expect(updated.folderName).toBe("Alice (alice)");
      expect(updated.isArchived).toBe(true);

      // Second channel wants the same folder name -> disambiguated with channel ID
      const colliding = store.upsertChannel(
        { id: "D2", is_im: true, user: "U2" },
        "im",
        "alice (alice)",
      );
      expect(colliding.folderName).toBe("alice (alice) (D2)");
    } finally {
      store.close();
    }
  });

  test("does not dirty historical parent day when only reply_count/latest_reply changes", () => {
    const store = new ArchiveStore(":memory:");
    try {
      store.upsertChannel(
        { id: "C1", name: "general" },
        "public_channel",
        "general",
      );

      // Day 1: 2026-11-10T10:00:00Z = 1794304800
      const day1Ts = "1794304800.000100";
      const day1Utc = slackTsToUtcDay(day1Ts) as string;

      const first = store.upsertMessages("C1", [
        {
          ts: day1Ts,
          user: "U1",
          text: "Starting a thread",
          reply_count: 0,
        },
      ]);
      expect(first.dirtyDays).toEqual([day1Utc]);
      store.clearDirtyDay("C1", day1Utc);

      // Day 5: 2026-11-14T12:00:00Z = 1794657600
      const day5ReplyTs = "1794657600.000200";
      const day5Utc = slackTsToUtcDay(day5ReplyTs) as string;

      // Lookback returns parent with bumped reply_count/latest_reply + new reply on day 5
      const second = store.upsertMessages("C1", [
        {
          ts: day1Ts,
          user: "U1",
          text: "Starting a thread",
          reply_count: 1,
          latest_reply: day5ReplyTs,
        },
        {
          ts: day5ReplyTs,
          thread_ts: day1Ts,
          user: "U2",
          text: "Replying four days later",
        },
      ]);

      // Only day 5 should be marked dirty; day 1 remains untouched
      expect(second.dirtyDays).toEqual([day5Utc]);
      expect(store.getDirtyDays("C1")).toEqual([
        { channelId: "C1", dayUtc: day5Utc },
      ]);

      const threadState = store.getThreadSyncState("C1", day1Ts);
      expect(threadState).toEqual({
        replyCount: 1,
        latestReply: day5ReplyTs,
        storedReplyCount: 1,
      });

      // Editing parent text on day 1 SHOULD dirty both day 1 and day 5 (reply quotes snippet)
      store.clearDirtyDay("C1", day5Utc);
      const edit = store.upsertMessages("C1", [
        {
          ts: day1Ts,
          user: "U1",
          text: "Starting a thread (edited)",
          reply_count: 1,
          latest_reply: day5ReplyTs,
        },
      ]);
      expect(edit.dirtyDays).toEqual([day1Utc, day5Utc]);
    } finally {
      store.close();
    }
  });

  test("tracks last_message_ts monotonically via pickNewerTs", () => {
    expect(pickNewerTs(null, "100.1")).toBe("100.1");
    expect(pickNewerTs("200.5", "100.1")).toBe("200.5");
    expect(pickNewerTs("200.5", "200.9")).toBe("200.9");
  });
});
