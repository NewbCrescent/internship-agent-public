import { describe, expect, it } from "vitest";

import {
  candidateFactSchema,
  courseEvidenceId,
  courseEvidenceText,
  courseworkSetSchema,
  factDefinitions,
  formatCourseworkAnswer,
  type Course
} from "@internship-agent/domain";

// Neutral fixtures: a fictional school and generic course codes.
const school = "Example State University";
const course = (code: string, title: string, status: Course["status"] = "completed", term = "Fall 2025"): Course =>
  ({ code, title, term, status });

describe("coursework file schema", () => {
  it("trims and collapses whitespace and accepts an empty list", () => {
    const parsed = courseworkSetSchema.parse({
      school: "  Example   State University ",
      courses: [{ code: " CS  61B ", title: "Data   Structures", term: " Fall 2025", status: "completed" }]
    });
    expect(parsed).toEqual({ school, courses: [course("CS 61B", "Data Structures")] });
    expect(courseworkSetSchema.parse({ school, courses: [] })).toEqual({ school, courses: [] });
  });

  it("rejects grades, bad statuses, duplicate codes, ID-like numbers, an empty school, and more than 40 courses", () => {
    const valid = course("CS 61B", "Data Structures");
    const rejects = (input: unknown) => expect(courseworkSetSchema.safeParse(input).success).toBe(false);
    rejects({ school, courses: [{ ...valid, grade: "A" }] });
    rejects({ school, courses: [{ ...valid, status: "done" }] });
    rejects({ school, courses: [valid, course("cs 61b", "Data Structures again")] });
    rejects({ school, courses: [course("CS-61B", "Data Structures"), course("CS 61B", "Data Structures")] });
    rejects({ school, courses: [course("CS 61B", "Data Structures 123456789")] });
    rejects({ school: "Example 12345678", courses: [valid] });
    rejects({ school, courses: [{ ...valid, term: "Term 20251234" }] });
    rejects({ school, courses: [{ ...valid, code: "12345678" }] });
    rejects({ school: "   ", courses: [valid] });
    rejects({ courses: [valid] });
    rejects({ school, courses: Array.from({ length: 41 }, (_, index) => course(`CS ${index}`, `Course ${index}`)) });
    rejects({ school, courses: [valid], studentId: "x" });
    expect(courseworkSetSchema.safeParse({
      school,
      courses: Array.from({ length: 40 }, (_, index) => course(`CS ${index}`, `Course ${index}`))
    }).success).toBe(true);
  });
});

describe("coursework answer", () => {
  const courses = [
    course("CS 189", "Machine Learning", "in_progress", "Spring 2026"),
    course("CS 61B", "Data Structures"),
    course("CS 70", "Discrete Mathematics")
  ];

  it("lists completed courses first, then in-progress ones, keeping the stored order in each group", () => {
    const expected = "Data Structures (CS 61B); Discrete Mathematics (CS 70); Machine Learning (CS 189, in progress)";
    expect(formatCourseworkAnswer(courses)).toBe(expected);
    expect(formatCourseworkAnswer(courses)).toBe(formatCourseworkAnswer([...courses]));
    expect(formatCourseworkAnswer([])).toBeNull();
  });
});

describe("course evidence", () => {
  it("cites each course by its code and labels in-progress study", () => {
    expect(courseEvidenceId("CS 61B")).toBe("course:CS-61B");
    expect(courseEvidenceId(" cs  61b ")).toBe("course:CS-61B");
    const completed = courseEvidenceText(course("CS 61B", "Data Structures"), school);
    const inProgress = courseEvidenceText(course("CS 189", "Machine Learning", "in_progress", "Spring 2026"), school);
    expect(completed).toContain("Status: completed");
    expect(completed).toContain("Course: CS 61B Data Structures");
    expect(completed).toContain(`School: ${school}`);
    expect(inProgress).toContain("Status: in progress (not yet completed)");
    expect(inProgress).toContain("Term: Spring 2026");
    expect(completed).not.toMatch(/grade/i);
    expect(inProgress).not.toMatch(/grade/i);
  });
});

describe("relevant coursework fact definition", () => {
  it("is a global-only standard text fact", () => {
    const definition = factDefinitions.relevant_coursework;
    expect(definition.valueType).toBe("text");
    expect(definition.allowedScopes).toEqual(["global"]);
    expect(definition.sensitivity).toBe("standard");
    const now = new Date().toISOString();
    const fact = {
      id: "coursework:test",
      candidateId: "local",
      key: "relevant_coursework",
      scope: { kind: "global" },
      value: "Data Structures (CS 61B)",
      valueType: "text",
      source: "user",
      sourceDetail: { kind: "profile" },
      confidence: 1,
      sensitivity: "standard",
      reusePolicy: "auto",
      rememberedAt: now,
      createdAt: now,
      supersededAt: null,
      supersededById: null,
      revokedAt: null
    };
    expect(candidateFactSchema.safeParse(fact).success).toBe(true);
    expect(candidateFactSchema.safeParse({ ...fact, scope: { kind: "company", name: "Example Co" } }).success).toBe(false);
  });
});
