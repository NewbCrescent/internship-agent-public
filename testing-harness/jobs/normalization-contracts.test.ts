import { describe, expect, it } from "vitest";

import { jobConstraintsSchema, jobRequirementSchema, verifyTextSpan } from "@internship-agent/domain";
import {
  classifyApplicationType,
  classifyEmploymentType,
  contentHash,
  extractDeterministically,
  locationCountryCodes,
  readWellKnownCity,
  normalizePostingText,
  type ClassifiedRequirement,
  type RequirementCandidate,
  type RequirementClassifier
} from "@internship-agent/jobs";

import { HEADED_BULLETS, MIXED_CUES, PROSE_STYLE, SPARSE } from "./fixtures/postings";

const ALL_FIXTURES = { HEADED_BULLETS, PROSE_STYLE, SPARSE, MIXED_CUES };

describe("posting normalization", () => {
  it("is idempotent, so a re-pasted posting hashes the same", () => {
    for (const [name, raw] of Object.entries(ALL_FIXTURES)) {
      const once = normalizePostingText(raw);
      const twice = normalizePostingText(once);
      expect(twice, name).toBe(once);
      expect(contentHash(twice), name).toBe(contentHash(once));
    }
  });

  it("folds unicode bullets and whitespace variants into one hash", () => {
    const unicode = normalizePostingText("Requirements:\r\n•  Must know Python \r\n");
    const ascii = normalizePostingText("Requirements:\n* Must know Python\n");
    expect(unicode).toBe(ascii);
    expect(contentHash(unicode)).toBe(contentHash(ascii));
  });
});

describe("span provenance", () => {
  it("anchors every extracted field to text the posting actually contains", () => {
    for (const [name, raw] of Object.entries(ALL_FIXTURES)) {
      const text = normalizePostingText(raw);
      const extraction = extractDeterministically(text);

      for (const requirement of extraction.requirements) {
        expect(verifyTextSpan(text, requirement.span), `${name} requirement`).toBe(true);
      }
      for (const technology of extraction.technologies) {
        expect(verifyTextSpan(text, technology.span), `${name} technology`).toBe(true);
      }
      for (const location of extraction.locations) {
        expect(verifyTextSpan(text, location.span), `${name} location`).toBe(true);
      }
      if (extraction.compensation) {
        expect(verifyTextSpan(text, extraction.compensation.span), `${name} compensation`).toBe(true);
      }
      for (const constraint of Object.values(extraction.constraints)) {
        if (constraint) expect(verifyTextSpan(text, constraint.span), `${name} constraint`).toBe(true);
      }
    }
  });

  it("rejects a span whose excerpt does not match the snapshot", () => {
    const text = normalizePostingText(SPARSE);
    expect(verifyTextSpan(text, { start: 0, end: 5, excerpt: "wrong" })).toBe(false);
    expect(verifyTextSpan(text, { start: 0, end: 7, excerpt: text.slice(0, 7) })).toBe(true);
  });
});

describe("hard versus preferred separation", () => {
  it("extracts explicit inline requirements without treating general prose as requirements", () => {
    const text = normalizePostingText([
      "Our interns build trading tools. Proficiency with C or C++ and Linux is preferred. Proficiency with Python is required.",
      "Our team requires Python to build its internal tools."
    ].join("\n"));
    const { requirements } = extractDeterministically(text);
    expect(requirements.map(({ text: excerpt, category, subject }) => ({ excerpt, category, subject }))).toEqual([
      { excerpt: "Proficiency with C or C++ and Linux is preferred.", category: "PREFERRED", subject: "SKILL" },
      { excerpt: "Proficiency with Python is required.", category: "HARD", subject: "SKILL" }
    ]);
    expect(requirements.every((requirement) => verifyTextSpan(text, requirement.span))).toBe(true);
  });

  it("keeps a preferred cue preferred even inside a requirements block", () => {
    const text = normalizePostingText(MIXED_CUES);
    const { requirements } = extractDeterministically(text);
    const byText = (needle: string) => requirements.find((requirement) => requirement.text.includes(needle));

    expect(byText("SQL required")?.category).toBe("HARD");
    expect(byText("Airflow experience preferred")?.category).toBe("PREFERRED");
    expect(byText("Docker exposure is a bonus")?.category).toBe("PREFERRED");
  });

  it("defaults an uncued bullet under no heading to preferred", () => {
    const text = normalizePostingText("Some role\n\n- Comfortable collaborating across teams\n");
    const { requirements } = extractDeterministically(text);
    expect(requirements).toHaveLength(1);
    expect(requirements[0].category).toBe("PREFERRED");
  });

  /**
   * Phrasing patterns observed in the real acceptance corpus. Real postings
   * seldom write "Requirements:"; they invite rather than demand. A soft
   * invitation must not become a hard requirement, because it does not say the
   * candidate is ineligible without it.
   */
  it("treats soft invitation headings as preferred, not hard", () => {
    const text = normalizePostingText([
      "We'd love to hear from you if you have:",
      "- Coursework in data structures",
      "",
      "While it's not required, it's an added plus if you also have:",
      "- Exposure to Kubernetes",
      "",
      "Preferred but not required",
      "- Prior internship experience"
    ].join("\n"));

    const { requirements } = extractDeterministically(text);
    expect(requirements).toHaveLength(3);
    expect(requirements.every((requirement) => requirement.category === "PREFERRED")).toBe(true);
  });

  it("still reads an explicit requirements heading as hard", () => {
    const text = normalizePostingText([
      "What we're looking for:",
      "- Enrolled in a Bachelor's program"
    ].join("\n"));

    const { requirements } = extractDeterministically(text);
    expect(requirements[0].category).toBe("HARD");
  });

  it("refuses a hard requirement that is only inferred", () => {
    const parsed = jobRequirementSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
      text: "Probably wants five years of experience",
      category: "HARD",
      subject: "EXPERIENCE",
      extraction: "MODEL",
      assertion: "INFERRED",
      confidence: 0.8,
      span: { start: 0, end: 4, excerpt: "Prob" }
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message.includes("never inferred"))).toBe(true);
  });
});

describe("stated constraints", () => {
  it("records sponsorship and authorization only when the posting commits", () => {
    const text = normalizePostingText(HEADED_BULLETS);
    const { constraints } = extractDeterministically(text);

    expect(constraints.authorization?.requiresExistingAuthorization).toBe(true);
    expect(constraints.authorization?.countryCode).toBe("US");
    expect(constraints.sponsorship?.sponsorshipAvailable).toBe(false);
  });

  it("leaves an unstated constraint null rather than guessing a value", () => {
    const { constraints } = extractDeterministically(normalizePostingText(SPARSE));
    expect(constraints.sponsorship).toBeNull();
    expect(constraints.authorization).toBeNull();
    expect(constraints.graduation).toBeNull();
    expect(constraints.availability).toBeNull();
  });

  it("records a season-only graduation window as stated without inventing dates", () => {
    const text = normalizePostingText("Candidates graduating in Spring 2028 are eligible.\n");
    const { constraints } = extractDeterministically(text);
    expect(constraints.graduation?.assertion).toBe("STATED");
    expect(constraints.graduation?.earliest).toBeNull();
    expect(constraints.graduation?.latest).toBeNull();
  });

  it("derives a month window only from an explicit month and year", () => {
    const text = normalizePostingText(PROSE_STYLE);
    const { constraints } = extractDeterministically(text);
    expect(constraints.graduation?.earliest).toBe("2027-12-01");
    expect(constraints.graduation?.latest).toBe("2028-05-31");
  });

  it("keeps a window of an over-long authorization sentence, with no period or newline, within the schema limit", () => {
    // A fictional posting: one comma-joined "sentence" of about 900 characters.
    const clauses = Array.from({ length: 9 }, (_, index) => `you will pair with the fixture platform team on internal build tooling for robotics project ${index + 1}`);
    const sentence = [...clauses.slice(0, 5), "and every applicant must be legally authorized to work in the United States", ...clauses.slice(5)].join(", ");
    expect(sentence.length).toBeGreaterThan(800);
    const text = normalizePostingText(`About the role\n${sentence}\n`);
    const { constraints } = extractDeterministically(text);
    const authorization = constraints.authorization;
    expect(authorization).not.toBeNull();
    expect(authorization!.raw.length).toBeLessThanOrEqual(600);
    expect(authorization!.raw).toContain("authorized to work");
    expect(verifyTextSpan(text, authorization!.span)).toBe(true);
    expect(authorization!.requiresExistingAuthorization).toBe(true);
    expect(authorization!.countryCode).toBe("US");
    expect(() => jobConstraintsSchema.parse(constraints)).not.toThrow();

    const short = normalizePostingText("Applicants must be legally authorized to work in the United States.\n");
    expect(extractDeterministically(short).constraints.authorization?.raw).toBe("Applicants must be legally authorized to work in the United States");
  });
});

describe("compensation and locations", () => {
  it("parses ranges, single rates, and an amount-free stipend", () => {
    const headed = extractDeterministically(normalizePostingText(HEADED_BULLETS)).compensation;
    expect(headed).toMatchObject({ minimum: 45, maximum: 62, period: "HOUR", currency: "USD" });

    const mixed = extractDeterministically(normalizePostingText(MIXED_CUES)).compensation;
    expect(mixed).toMatchObject({ minimum: 30, maximum: null, period: "HOUR" });

    const prose = extractDeterministically(normalizePostingText(PROSE_STYLE)).compensation;
    expect(prose).toMatchObject({ period: "STIPEND", minimum: null });

    expect(extractDeterministically(normalizePostingText(SPARSE)).compensation).toBeNull();
  });

  it("reads city/state pairs and remote postings", () => {
    const headed = extractDeterministically(normalizePostingText(HEADED_BULLETS)).locations;
    expect(headed[0]).toMatchObject({ city: "Austin", region: "TX", countryCode: "US" });

    const hybrid = extractDeterministically(normalizePostingText(MIXED_CUES)).locations;
    expect(hybrid[0]).toMatchObject({ city: "Chicago", region: "IL", workMode: "HYBRID" });

    const remote = extractDeterministically(normalizePostingText(PROSE_STYLE)).locations;
    expect(remote[0]).toMatchObject({ workMode: "REMOTE", city: null });
  });
});

describe("location and pay formats seen on real boards", () => {
  const locationsOf = (line: string) => {
    const text = normalizePostingText(`Software Engineering Intern\n${line}\n\nAbout the team\nWe build things.`);
    const locations = extractDeterministically(text).locations;
    for (const location of locations) expect(verifyTextSpan(text, location.span), line).toBe(true);
    return locations;
  };
  const payOf = (line: string) => {
    const text = normalizePostingText(`Software Engineering Intern\n\n${line}\n`);
    const compensation = extractDeterministically(text).compensation;
    if (compensation) expect(verifyTextSpan(text, compensation.span), line).toBe(true);
    return compensation;
  };

  it("reads labelled locations that name a full state, province, or country", () => {
    expect(locationsOf("Location: Northfield, Illinois")).toMatchObject([{ city: "Northfield", region: "IL", countryCode: "US" }]);
    expect(locationsOf("Location: US-California-Palo Alto")).toMatchObject([{ city: "Palo Alto", region: "CA", countryCode: "US" }]);
    expect(locationsOf("Location: Edmonton, AB - 10160 103 St. NW")).toMatchObject([{ city: "Edmonton", region: "AB", countryCode: "CA" }]);
    expect(locationsOf("Location: Toronto, Ontario, Canada")).toMatchObject([{ city: "Toronto", region: "ON", countryCode: "CA" }]);
    expect(locationsOf("Location: Germany, Munich")).toMatchObject([{ city: "Munich", region: null, countryCode: "DE" }]);
    expect(locationsOf("Location: Belfast, United Kingdom")).toMatchObject([{ city: "Belfast", countryCode: "GB" }]);
    expect(locationsOf("Location: Malaysia, Penang")).toMatchObject([{ city: "Penang", countryCode: "MY" }]);
    expect(locationsOf("Location: New York")).toMatchObject([{ city: null, region: "NY", countryCode: "US" }]);
    expect(locationsOf("Location: Atlanta, Georgia")).toMatchObject([{ city: "Atlanta", region: "GA", countryCode: "US" }]);
  });

  it("keeps each place in a multi-location line and reads remote work with a country", () => {
    expect(locationsOf("Locations: Austin, TX; Toronto, ON")).toMatchObject([
      { city: "Austin", region: "TX", countryCode: "US" },
      { city: "Toronto", region: "ON", countryCode: "CA" }
    ]);
    expect(locationsOf("Location: Home Working, United States")).toMatchObject([{ city: null, countryCode: "US", workMode: "REMOTE" }]);
    expect(locationsOf("Location: Toronto, ON, CA")).toMatchObject([{ city: "Toronto", region: "ON", countryCode: "CA" }]);
  });

  it("reads a standalone place line but never a place mentioned in prose", () => {
    expect(locationsOf("Toronto, Ontario, Canada")).toMatchObject([{ city: "Toronto", countryCode: "CA" }]);
    expect(locationsOf("We have offices in Berlin, Germany and Paris, France.")).toEqual([]);
  });

  it("reads a well-known city on a labelled line, and leaves an unknown or ambiguous bare city unknown", () => {
    expect(locationsOf("Location: Berlin")).toMatchObject([{ city: "Berlin", region: null, countryCode: "DE" }]);
    expect(locationsOf("Location: Paris")).toMatchObject([{ countryCode: "FR" }]);
    expect(locationsOf("Location: London")).toMatchObject([{ countryCode: "GB" }]);
    expect(locationsOf("Location: San Francisco")).toMatchObject([{ countryCode: "US" }]);
    expect(locationsOf("Location: South San Francisco")).toMatchObject([{ city: "South San Francisco", countryCode: "US" }]);
    expect(locationsOf("Location: Berlin (Hybrid)")).toMatchObject([{ city: "Berlin", countryCode: "DE", workMode: "HYBRID" }]);
    // An explicit country or "City, ST" always wins over the city table.
    expect(locationsOf("Location: Seoul, South Korea")).toMatchObject([{ city: "Seoul", countryCode: "KR" }]);
    expect(locationsOf("Location: Paris, TX")).toMatchObject([{ city: "Paris", region: "TX", countryCode: "US" }]);
    expect(locationsOf("Location: London, Ontario")).toMatchObject([{ city: "London", region: "ON", countryCode: "CA" }]);
    expect(locationsOf("Location: Hybrid; Johnston, Iowa, United States")).toMatchObject([{ city: "Johnston", region: "IA", countryCode: "US" }]);
    // Unknown and ambiguous bare cities keep the hold.
    expect(locationsOf("Location: Springfield")).toEqual([]);
    expect(locationsOf("Location: Cambridge")).toEqual([]);
    expect(locationsOf("Location: Johnston")).toEqual([]);
    // Prose never reads, even naming a well-known city.
    expect(locationsOf("Our team works closely with colleagues in Berlin every week.")).toEqual([]);
  });

  it("reads a work-mode lead-in before a place as that place with its work mode (Track 43)", () => {
    const opensesame = locationsOf("Job list location: Remote in USA\n\nLocation: Remote\n\nThis role can be based anywhere in the U.S.");
    expect(opensesame).toHaveLength(1);
    expect(opensesame[0]).toMatchObject({ city: null, region: null, countryCode: "US", workMode: "REMOTE" });
    expect(locationsOf("Location: Remote within the United States")).toMatchObject([{ countryCode: "US", workMode: "REMOTE" }]);
    expect(locationsOf("Location: Hybrid in Canada")).toMatchObject([{ countryCode: "CA", workMode: "HYBRID" }]);
    expect(locationsOf("Location: Remote")).toMatchObject([{ countryCode: null, workMode: "REMOTE" }]);
    expect(locationCountryCodes("Remote in USA")).toEqual(["US"]);
  });

  it("reads the countries one ATS location string names", () => {
    expect(locationCountryCodes("Berlin, Germany")).toEqual(["DE"]);
    expect(locationCountryCodes("Seattle, WA")).toEqual(["US"]);
    expect(locationCountryCodes("South San Francisco")).toEqual(["US"]);
    expect(locationCountryCodes("Paris; Toronto, ON")).toEqual(["FR", "CA"]);
    expect(locationCountryCodes("Hybrid")).toEqual([]);
    expect(locationCountryCodes("2 Locations")).toEqual([]);
    expect(readWellKnownCity("Greater Seattle Area")).toEqual({ code: "US" });
    expect(readWellKnownCity("Zürich")).toEqual({ code: "CH" });
    expect(readWellKnownCity("Waterloo")).toBeNull();
  });

  it("reads pay written with an -ly unit, a leading pay label, or a currency code", () => {
    expect(payOf("Pay - $19 - $25/hourly")).toMatchObject({ minimum: 19, maximum: 25, period: "HOUR", currency: "USD" });
    expect(payOf("The U.S. pay range for this position is $45.00 - $55.00 hourly.")).toMatchObject({ minimum: 45, maximum: 55, period: "HOUR" });
    expect(payOf("The hourly rate for this internship is USD $58.37 hourly")).toMatchObject({ minimum: 58.37, maximum: null, period: "HOUR", currency: "USD" });
    expect(payOf("Canada Hourly Rate Band $35 &mdash; $55 CAD")).toMatchObject({ minimum: 35, maximum: 55, period: "HOUR", currency: "CAD" });
    expect(payOf("The hourly compensation range for this internship is $20 to $33, set by location.")).toMatchObject({ minimum: 20, maximum: 33, period: "HOUR" });
    expect(payOf("Base salary: $120,000 – $150,000 USD per year")).toMatchObject({ minimum: 120_000, maximum: 150_000, period: "YEAR", currency: "USD" });
    expect(payOf("$90k-$110k annually")).toMatchObject({ minimum: 90_000, maximum: 110_000, period: "YEAR" });
    expect(payOf("Stipend of $7,500 monthly")).toMatchObject({ minimum: 7_500, period: "MONTH" });
    expect(payOf("The annual base pay for this role is expected to be between $100,000 and $150,000.")).toMatchObject({ minimum: 100_000, maximum: 150_000, period: "YEAR" });
    expect(payOf("The hourly pay range for this position in California is $40/hr - $48/hr.")).toMatchObject({ minimum: 40, period: "HOUR", raw: "$40/hr" });
  });

  it("does not read company figures as pay", () => {
    expect(payOf("Sales of $12 billion annually across nine states.")).toBeNull();
    expect(payOf("Our annual revenue is $5 billion.")).toBeNull();
  });
});

describe("source and employment classification", () => {
  it("derives the application type from the supplied URLs", () => {
    expect(classifyApplicationType("https://app.joinhandshake.com/jobs/1", null)).toBe("HANDSHAKE_INTERNAL");
    expect(classifyApplicationType("https://boards.greenhouse.io/acme/jobs/1", null)).toBe("EXTERNAL_ATS");
    expect(classifyApplicationType("https://app.joinhandshake.com/jobs/1", "https://jobs.lever.co/acme/1"))
      .toBe("EXTERNAL_ATS");
    expect(classifyApplicationType("https://app.joinhandshake.com/jobs/1", "https://acme.example/careers/1"))
      .toBe("EMPLOYER_SITE");
    expect(classifyApplicationType("https://example.test/posting", null)).toBe("UNKNOWN");
  });

  it("classifies employment type from the title and body", () => {
    expect(classifyEmploymentType("Software Engineering Intern", "")).toBe("INTERNSHIP");
    expect(classifyEmploymentType("Engineering Co-op", "")).toBe("CO_OP");
    expect(classifyEmploymentType("Software Engineer", "This is a new grad role.")).toBe("NEW_GRAD");
    expect(classifyEmploymentType("Staff Engineer", "Senior position.")).toBe("OTHER");
  });
});

describe("classifier boundary", () => {
  it("gives a classifier only indices and text, never a span to move", async () => {
    const text = normalizePostingText(HEADED_BULLETS);
    const candidates = extractDeterministically(text).requirements;

    let seen: RequirementCandidate[] = [];
    const spy: RequirementClassifier = {
      method: "MODEL",
      async classify(given): Promise<ClassifiedRequirement[]> {
        seen = given;
        return [];
      }
    };
    await spy.classify(candidates, { title: "t", companyName: "c", jobId: null });

    expect(seen.length).toBeGreaterThan(0);
    for (const candidate of seen) {
      expect(verifyTextSpan(text, candidate.span)).toBe(true);
    }
  });
});
