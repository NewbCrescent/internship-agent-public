import { describe, expect, it } from "vitest";

import { assertOutcomeTransition } from "@internship-agent/agent";
import type { JobPostingStatus } from "@internship-agent/domain";

const ALLOWED: Array<[JobPostingStatus, "INTERVIEW" | "REJECTED" | "OFFER" | "WITHDRAWN"]> = [
  ["SUBMITTED", "INTERVIEW"],
  ["SUBMITTED", "REJECTED"],
  ["SUBMITTED", "OFFER"],
  ["SUBMITTED", "WITHDRAWN"],
  ["INTERVIEW", "OFFER"],
  ["INTERVIEW", "REJECTED"],
  ["INTERVIEW", "WITHDRAWN"]
];

const DENIED: Array<[JobPostingStatus, "INTERVIEW" | "REJECTED" | "OFFER" | "WITHDRAWN"]> = [
  ["INTERVIEW", "INTERVIEW"],
  ["SUBMITTED", "SUBMITTED"],
  ["OFFER", "REJECTED"],
  ["OFFER", "WITHDRAWN"],
  ["REJECTED", "OFFER"],
  ["WITHDRAWN", "INTERVIEW"],
  ["QUALIFIED", "INTERVIEW"],
  ["APPROVED", "OFFER"],
  ["READY_FOR_REVIEW", "REJECTED"],
  ["DISCOVERED", "WITHDRAWN"]
];

describe("outcome transitions", () => {
  it("allows every post-submission step and nothing else", () => {
    for (const [from, to] of ALLOWED) {
      expect(() => assertOutcomeTransition(from, to)).not.toThrow();
    }
  });

  it("refuses jumps, repeats, and any update once the application is closed", () => {
    for (const [from, to] of DENIED) {
      expect(() => assertOutcomeTransition(from, to)).toThrow();
    }
  });

  it("allows detailed stages only after submission and final rounds only after interview", () => {
    for (const stage of ["RESPONSE", "OA", "SCREEN", "GHOSTED"] as const) {
      expect(() => assertOutcomeTransition("SUBMITTED", stage)).not.toThrow();
      expect(() => assertOutcomeTransition("QUALIFIED", stage)).toThrow();
    }
    expect(() => assertOutcomeTransition("SUBMITTED", "FINAL")).toThrow();
    expect(() => assertOutcomeTransition("INTERVIEW", "FINAL")).not.toThrow();
  });
});
