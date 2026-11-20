import { describe, expect, it } from "vitest";

import {
  contentDedupeKey,
  dedupeItems,
  parsePostingBatch,
  postingDedupeKey,
  repostKey,
  selectPromotion
} from "@internship-agent/jobs";

describe("bulk posting parser", () => {
  it("splits blocks on === lines and reads Title @ Company headers", () => {
    const batch = [
      "Software Engineering Intern @ Aurora Labs",
      "Source: https://example.com/jobs/1",
      "We build developer tools in Python. This twelve-week internship runs in Seattle and welcomes students.",
      "===",
      "Data Engineering Intern @ Beacon Systems",
      "SQL and Python pipelines over the summer in San Francisco for enrolled students learning data systems."
    ].join("\n");
    const { items, errors } = parsePostingBatch(batch);
    expect(errors).toHaveLength(0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Software Engineering Intern",
      companyName: "Aurora Labs",
      sourceUrl: "https://example.com/jobs/1"
    });
    expect(items[1].sourceUrl).toBeNull();
  });

  it("rejects blocks that are too short or lack a header, and keeps the survivors", () => {
    const { items, errors } = parsePostingBatch("no header here\n===\nHas Header @ Co\nToo short");
    expect(items).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it("parses every block; the intake bound lives in the orchestrator, not the parser", () => {
    const block = "Intern @ Co\n" + "x".repeat(250);
    const { items, errors } = parsePostingBatch(Array.from({ length: 120 }, () => block).join("\n===\n"));
    expect(errors).toHaveLength(0);
    expect(items).toHaveLength(120);
  });

  it("leaves an empty batch empty so the orchestrator can refuse it", () => {
    const { items, errors } = parsePostingBatch("   ");
    expect(items).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe("dedupe keys", () => {
  it("treats case and spacing differences as the same content", () => {
    expect(contentDedupeKey("  Python   Internship ")).toBe(contentDedupeKey("python internship"));
  });

  it("keys reposts by normalized company and title", () => {
    expect(repostKey("Aurora Labs", "Software Engineering Intern")).toBe(
      repostKey("aurora  labs", "software engineering intern")
    );
    expect(repostKey("Aurora Labs", "Data Intern")).not.toBe(repostKey("Aurora Labs", "Software Engineering Intern"));
  });

  it("dedupes matching posts while preserving distinct text under one company and title", () => {
    const text = "We build developer tools in Python over a twelve-week Seattle internship for students.";
    const { unique, duplicates } = dedupeItems(
      [
        { title: "Software Engineering Intern", companyName: "Aurora Labs", text },
        { title: "Software Engineering Intern", companyName: "Aurora Labs", text: ` ${text.toUpperCase()} ` },
        { title: "Software Engineering Intern", companyName: "Aurora Labs", text: "A different posting about Go systems and mentorship over twelve weeks in Seattle." }
      ],
      (item) => [postingDedupeKey(item.companyName, item.title, item.text)]
    );
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(1);
    expect(postingDedupeKey("Beacon Systems", "Software Engineering Intern", text)).not.toBe(
      postingDedupeKey("Aurora Labs", "Software Engineering Intern", text)
    );
  });
});

describe("promotion selection", () => {
  const ranked = [
    { jobId: "a", verdict: "QUALIFIED", fitScore: 80 },
    { jobId: "b", verdict: "QUALIFIED", fitScore: 90 },
    { jobId: "c", verdict: "NEEDS_REVIEW", fitScore: 95 },
    { jobId: "d", verdict: "NOT_QUALIFIED", fitScore: 99 }
  ];

  it("promotes only qualified postings, best fit first, even when others score higher", () => {
    const promoted = selectPromotion(ranked, { threshold: 0, limit: 10 });
    expect(promoted.map((entry) => entry.jobId)).toEqual(["b", "a"]);
  });

  it("applies a fit threshold and a top-k limit", () => {
    expect(selectPromotion(ranked, { threshold: 85, limit: 10 }).map((entry) => entry.jobId)).toEqual(["b"]);
    expect(selectPromotion(ranked, { threshold: 0, limit: 1 }).map((entry) => entry.jobId)).toEqual(["b"]);
  });

  it("breaks fit ties by job id so the order stays deterministic", () => {
    const tied = [
      { jobId: "b", verdict: "QUALIFIED", fitScore: 80 },
      { jobId: "a", verdict: "QUALIFIED", fitScore: 80 }
    ];
    expect(selectPromotion(tied, { threshold: 0, limit: 10 }).map((entry) => entry.jobId)).toEqual(["a", "b"]);
  });

  it("promotes nothing when every score misses the bar", () => {
    expect(selectPromotion(ranked, { threshold: 99, limit: 5 })).toHaveLength(0);
  });
});
