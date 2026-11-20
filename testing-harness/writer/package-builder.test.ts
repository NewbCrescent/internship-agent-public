import { describe, expect, it } from "vitest";

import {
  jobPostingSchema,
  type CandidateFact,
  type CandidatePreference,
  type CandidateProfileInput,
  type JobPosting,
  type ResumeEntry
} from "@internship-agent/domain";
import { approvedEntries, buildApplicationPackage, type UsableClaim } from "@internship-agent/writer";

const POSTING_ID = "11111111-1111-4111-8111-111111111111";

function span(text: string) {
  return { start: 0, end: text.length, excerpt: text };
}

function posting(): JobPosting {
  const location = "The role is based in Seattle, WA.";
  const python = "We build our platform in Python.";
  return jobPostingSchema.parse({
    id: POSTING_ID,
    companyName: "Aurora Labs",
    title: "Software Engineering Intern",
    employmentType: "INTERNSHIP",
    status: "QUALIFIED",
    source: {
      applicationType: "HANDSHAKE_INTERNAL",
      sourceUrl: "https://app.joinhandshake.com/jobs/900001",
      externalApplicationUrl: null,
      companyCareersUrl: null
    },
    snapshot: {
      id: "22222222-2222-4222-8222-222222222222",
      jobId: POSTING_ID,
      contentHash: "hash",
      normalizedText: `Software Engineering Intern. ${location} ${python}`,
      capturedAt: "2026-09-22T12:00:00.000Z"
    },
    locations: [{
      jobId: POSTING_ID,
      raw: "Seattle, WA",
      city: "Seattle",
      region: "WA",
      countryCode: "US",
      workMode: "ONSITE",
      span: span("Seattle, WA")
    }],
    compensation: null,
    requirements: [],
    technologies: [{
      jobId: POSTING_ID,
      label: "Python",
      normalizedKey: "python",
      extraction: "DETERMINISTIC",
      span: span("Python")
    }],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null },
    createdAt: "2026-09-22T12:00:00.000Z",
    updatedAt: "2026-09-22T12:00:00.000Z"
  });
}

function fact(key: CandidateFact["key"], scope: CandidateFact["scope"], value: boolean | string): CandidateFact {
  return {
    id: `${key}-fact`,
    candidateId: "local-candidate",
    key,
    scope,
    value,
    valueType: (typeof value === "boolean" ? "boolean" : "date") as "boolean" | "date",
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    sensitivity: "standard",
    reusePolicy: "auto",
    rememberedAt: "2026-09-22T12:00:00.000Z",
    createdAt: "2026-09-22T12:00:00.000Z",
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  };
}

const PROFILE: CandidateProfileInput & { id: string } = {
  id: "local-candidate",
  fullName: "Jordan Rivera",
  school: "Example State University",
  degree: "B.S. Computer Science",
  graduationDate: "2027-05-15"
};

const PREFERENCES: CandidatePreference = {
  candidateId: "local-candidate",
  roleTypes: ["Software Engineering"],
  locations: ["Seattle, WA"],
  workModes: ["onsite"],
  industries: [],
  excludeGraduateOnlyInternships: false,
  updatedAt: "2026-09-22T12:00:00.000Z"
};

const PYTHON_CLAIM: UsableClaim = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "technology",
  normalizedKey: "python",
  text: "Shipped Python services in production."
};

function resumeEntry(
  id: string,
  section: ResumeEntry["section"],
  content: { title: string; role?: string; bullets: string[] },
  state: { reviewStatus?: "PENDING" | "APPROVED"; archived?: boolean } = {}
): ResumeEntry {
  return {
    id,
    candidateId: "local-candidate",
    section,
    position: 0,
    archivedAt: state.archived ? "2026-09-22T12:00:00.000Z" : null,
    createdAt: "2026-09-22T12:00:00.000Z",
    current: {
      id: id.replace(/^.{8}/, "99999999"),
      entryId: id,
      title: content.title,
      role: content.role ?? null,
      linkLabel: null,
      linkUrl: null,
      location: "Seattle, WA",
      dateText: "2026",
      bullets: content.bullets,
      source: { kind: "user" },
      reviewStatus: state.reviewStatus ?? "APPROVED",
      approvedAt: "2026-09-22T12:00:00.000Z",
      createdAt: "2026-09-22T12:00:00.000Z",
      supersededAt: null
    }
  };
}

const RESUME_ENTRIES: ResumeEntry[] = [
  resumeEntry("44444444-4444-4444-8444-444444444444", "experience", {
    title: "Aurora Labs",
    role: "Software Engineering Intern",
    bullets: ["Built Python ingestion services processing 40% more files."]
  }),
  resumeEntry("55555555-5555-4555-8555-555555555555", "skills", { title: "Languages", bullets: ["Python", "TypeScript"] })
];

describe("deterministic application assembly", () => {
  it("grounds every bullet and answer in the claim ledger", () => {
    const draft = buildApplicationPackage(posting(), {
      facts: [
        fact("authorized_to_work", { kind: "country", code: "US" }, true),
        fact("requires_sponsorship", { kind: "country", code: "US" }, false),
        fact("available_start_date", { kind: "global" }, "2027-06-01")
      ],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims: [PYTHON_CLAIM],
      resumeEntries: RESUME_ENTRIES
    });
    expect(draft.missingFacts).toEqual([]);
    expect(draft.package.bullets.length).toBeGreaterThan(0);

    const ledger = new Map(draft.package.claims.map((claim) => [claim.id, claim]));
    for (const bullet of draft.package.bullets) {
      expect(bullet.claimIds.length).toBeGreaterThan(0);
      for (const id of bullet.claimIds) {
        const claim = ledger.get(id);
        expect(claim?.basis.kind).toBe("resume_entry");
        expect(claim?.text).toBe(bullet.text);
      }
    }
    for (const answer of draft.package.answers) {
      expect(answer.claimIds.length).toBeGreaterThan(0);
      for (const id of answer.claimIds) {
        expect(ledger.has(id), `answer ${answer.prompt} references a missing claim`).toBe(true);
      }
    }
  });

  it("quotes the posting with checkable excerpts", () => {
    const draft = buildApplicationPackage(posting(), {
      facts: [],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims: [],
      resumeEntries: RESUME_ENTRIES
    });
    const snapshot = posting().snapshot.normalizedText;
    const postingClaims = draft.package.claims.filter((claim) => claim.basis.kind === "posting");
    expect(postingClaims.length).toBeGreaterThan(0);
    for (const claim of postingClaims) {
      if (claim.basis.kind !== "posting") continue;
      const excerpt = claim.basis.excerpt;
      const known = excerpt === posting().title
        || excerpt === posting().companyName
        || snapshot.includes(excerpt);
      expect(known, `excerpt is not checkable: ${excerpt}`).toBe(true);
    }
  });

  it("omits the authorization answer and names missing facts", () => {
    const draft = buildApplicationPackage(posting(), {
      facts: [],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims: [PYTHON_CLAIM],
      resumeEntries: RESUME_ENTRIES
    });
    expect(draft.package.answers.some((answer) =>
      answer.prompt === "What is your work authorization and availability?"
    )).toBe(false);
    expect(draft.missingFacts).toEqual(
      expect.arrayContaining(["authorized_to_work", "requires_sponsorship", "available_start_date"])
    );
  });

  it("answers authorization directly from recorded facts", () => {
    const draft = buildApplicationPackage(posting(), {
      facts: [
        fact("authorized_to_work", { kind: "country", code: "US" }, true),
        fact("requires_sponsorship", { kind: "country", code: "US" }, false),
        fact("available_start_date", { kind: "global" }, "2027-06-01")
      ],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims: [],
      resumeEntries: RESUME_ENTRIES
    });
    const answer = draft.package.answers.find((item) =>
      item.prompt === "What is your work authorization and availability?"
    );
    expect(answer?.text).toContain("2027-06-01");
    expect(draft.missingFacts).toEqual([]);
  });

  it("draws package bullets only from entries on the resume", () => {
    const onResume = resumeEntry("11111111-1111-4111-8111-000000000001", "experience", { title: "Printed Co", role: "Intern", bullets: ["Printed bullet."] });
    const library = { ...resumeEntry("11111111-1111-4111-8111-000000000002", "experience", { title: "Library Co", role: "Tutor", bullets: ["Library bullet."] }), onResume: false };
    expect(approvedEntries([onResume, library]).map((item) => item.current.title)).toEqual(["Printed Co"]);
  });

  it("prints approved entries verbatim and never turns evidence into resume bullets", () => {
    const entries = [
      ...RESUME_ENTRIES,
      resumeEntry("66666666-6666-4666-8666-666666666666", "project", { title: "Pending project", bullets: ["Not yet approved."] }, { reviewStatus: "PENDING" }),
      resumeEntry("77777777-7777-4777-8777-777777777777", "project", { title: "Old project", bullets: ["Archived work."] }, { archived: true })
    ];
    const draft = buildApplicationPackage(posting(), {
      facts: [],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims: [PYTHON_CLAIM],
      resumeEntries: entries
    });
    expect(draft.package.bullets.map((bullet) => bullet.text)).toEqual([
      "Built Python ingestion services processing 40% more files.",
      "Languages: Python, TypeScript"
    ]);
    const headings = draft.package.claims.filter((claim) => claim.sourceField.startsWith("resume:"));
    expect(headings.map((claim) => claim.text)).toEqual(["Aurora Labs | Software Engineering Intern — Seattle, WA 2026"]);
    expect(draft.package.claims.some((claim) => claim.basis.kind === "evidence" && claim.sourceField.startsWith("bullet:"))).toBe(false);
  });

  it("mentions described experience only when the package describes some", () => {
    const interest = (evidenceClaims: UsableClaim[]) => buildApplicationPackage(posting(), {
      facts: [],
      preferences: PREFERENCES,
      profile: PROFILE,
      evidenceClaims,
      resumeEntries: RESUME_ENTRIES
    }).package.answers.find((answer) => answer.prompt === "Why are you interested in this role?")?.text ?? "";
    const without = interest([]);
    expect(without).not.toContain("described below");
    expect(without).not.toContain("  ");
    expect(without).toMatch(/names .+\.$/);
    expect(interest([PYTHON_CLAIM])).toContain("which matches the experience described below.");
  });
});
