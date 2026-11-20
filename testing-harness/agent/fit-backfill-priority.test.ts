import { describe, expect, it } from "vitest";

import { isPriorityPublication, prioritizeByPublication } from "@internship-agent/agent";

const NOW = Date.parse("2026-10-07T08:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const posting = (id: string, postedAt?: string | null) => ({
  id,
  publication: postedAt === undefined ? undefined : postedAt === null ? null : { postedAt }
});

describe("AI backfill publication priority", () => {
  it("scores postings published within the window first, newest first", () => {
    const input = [
      posting("old", hoursAgo(240)),
      posting("unknown", null),
      posting("fresh", hoursAgo(5)),
      posting("older-fresh", hoursAgo(70)),
      posting("future", new Date(NOW + 3_600_000).toISOString()),
      posting("malformed", "not-a-date")
    ];
    expect(prioritizeByPublication(input, 3, NOW).map((entry) => entry.id)).toEqual([
      "fresh",
      "older-fresh",
      "old",
      "unknown",
      "future",
      "malformed"
    ]);
  });

  it("includes both window boundaries and excludes future dates", () => {
    expect(isPriorityPublication({ postedAt: hoursAgo(72) }, 3, NOW)).toBe(true);
    expect(isPriorityPublication({ postedAt: hoursAgo(72.001) }, 3, NOW)).toBe(false);
    expect(isPriorityPublication({ postedAt: new Date(NOW).toISOString() }, 3, NOW)).toBe(true);
    expect(isPriorityPublication({ postedAt: new Date(NOW + 1).toISOString() }, 3, NOW)).toBe(false);
    expect(isPriorityPublication(null, 3, NOW)).toBe(false);
    expect(isPriorityPublication(undefined, 3, NOW)).toBe(false);
    expect(isPriorityPublication({ postedAt: "not-a-date" }, 3, NOW)).toBe(false);
  });

  it("keeps import order when priority is disabled", () => {
    const input = [posting("old", hoursAgo(240)), posting("fresh", hoursAgo(5))];
    const ordered = prioritizeByPublication(input, 0, NOW);
    expect(ordered.map((entry) => entry.id)).toEqual(["old", "fresh"]);
    expect(ordered).not.toBe(input);
  });
});
