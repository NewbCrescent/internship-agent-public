import { describe, expect, it } from "vitest";

import {
  bachelorKind,
  campusOption,
  chooseDegreeOption,
  matchPromptOption,
  planApplicationHistory,
  promptSearchTerms,
  sameNameKey,
  sameNamedOption,
  type Candidate,
  type EducationRow,
  type ResumeEntry
} from "@internship-agent/domain";

const CANDIDATE: Candidate = {
  id: "local-candidate",
  fullName: "Jordan Rivera",
  school: "UC Berkeley",
  degree: "B.A. Computer Science",
  fieldOfStudy: "Computer Science",
  gpa: "3.8",
  educationStartMonth: "2025-08",
  graduationDate: "2028-05-15",
  highSchoolName: "Northwind High School",
  highSchoolStartYear: "2021",
  highSchoolEndYear: "2025",
  createdAt: "2026-09-22T12:00:00.000Z",
  updatedAt: "2026-09-22T12:00:00.000Z"
};

function entry(id: string, overrides: Partial<ResumeEntry> & { current?: Partial<ResumeEntry["current"]> } = {}): ResumeEntry {
  const { current, ...rest } = overrides;
  return {
    id,
    candidateId: "local-candidate",
    section: "experience",
    position: 0,
    archivedAt: null,
    onResume: true,
    inWorkHistory: true,
    createdAt: "2026-09-22T12:00:00.000Z",
    ...rest,
    current: {
      id: `${id.slice(0, 35)}f`, entryId: id, title: "Northwind Tutoring", role: "Programming Tutor", linkLabel: null, linkUrl: null,
      location: "Berkeley, CA", dateText: "2026", bullets: ["Taught Python.", "Built lesson plans."], startMonth: "2026-02", endMonth: "2026-05",
      isCurrent: false, source: { kind: "user" }, reviewStatus: "APPROVED", approvedAt: "2026-09-22T12:00:00.000Z",
      createdAt: "2026-09-22T12:00:00.000Z", supersededAt: null, ...current
    }
  };
}

describe("application history", () => {
  it("lists only approved experience entries the candidate included, with their own dates and bullets", () => {
    const history = planApplicationHistory({
      entries: [
        entry("11111111-1111-4111-8111-111111111111"),
        entry("22222222-2222-4222-8222-222222222222", { inWorkHistory: false }),
        entry("33333333-3333-4333-8333-333333333333", { archivedAt: "2026-09-23T12:00:00.000Z" }),
        entry("44444444-4444-4444-8444-444444444444", { current: { reviewStatus: "PENDING" } }),
        entry("55555555-5555-4555-8555-555555555555", { section: "project" }),
        entry("66666666-6666-4666-8666-666666666666", { current: { title: "Contoso", role: "Founder", startMonth: "2026-05", endMonth: null, isCurrent: true } })
      ],
      candidate: CANDIDATE,
      graduationDate: "2028-05-15"
    });
    expect(history.work).toEqual([
      { entryId: "11111111-1111-4111-8111-111111111111", company: "Northwind Tutoring", title: "Programming Tutor", location: "Berkeley, CA",
        start: { year: 2026, month: 2 }, end: { year: 2026, month: 5 }, current: false, description: "Taught Python.\nBuilt lesson plans." },
      expect.objectContaining({ company: "Contoso", current: true, end: null })
    ]);
    expect(history.education).toEqual([
      { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: "Computer Science", gpa: "3.8", startYear: 2025, endYear: 2028 },
      { key: "high_school", school: "Northwind High School", level: "high_school", degree: null, fieldOfStudy: null, gpa: null, startYear: 2021, endYear: 2025 }
    ]);
    // The alternate (transcript) profile only changes the college end year.
    const alternate = planApplicationHistory({ entries: [], candidate: CANDIDATE, graduationDate: "2029-05-15" });
    expect(alternate.education[0]?.endYear).toBe(2029);
    expect(alternate.education[1]?.endYear).toBe(2025);
  });

  it("chooses the degree option of the same kind and never a B.S. for a B.A.", () => {
    const college: EducationRow = { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: null, gpa: null, startYear: null, endYear: null };
    const highSchool: EducationRow = { ...college, key: "high_school", level: "high_school", degree: null };
    expect(bachelorKind("B.A. Computer Science")).toBe("arts");
    expect(bachelorKind("MBA")).toBeNull();
    expect(chooseDegreeOption(college, ["High School Diploma", "Bachelor of Science (BS)", "Bachelor of Arts (BA)", "Bachelor's Degree"])).toBe("Bachelor of Arts (BA)");
    expect(chooseDegreeOption(college, ["Bachelor of Science", "Bachelor's Degree", "MBA"])).toBe("Bachelor's Degree");
    expect(chooseDegreeOption(college, ["BS", "Bachelor of Science", "Master's Degree"])).toBeNull();
    expect(chooseDegreeOption({ ...college, degree: "B.S. Computer Science" }, ["BA", "BS"])).toBe("BS");
    expect(chooseDegreeOption(highSchool, ["Some College", "High School or Equivalent", "Bachelor's Degree"])).toBe("High School or Equivalent");
    expect(chooseDegreeOption(highSchool, ["Associate's Degree"])).toBeNull();
  });

  it("picks a high-school diploma over a GED or equivalency option (rockwellautomation.wd1, neogen.wd5, zoll.wd5, 2026-11-25)", () => {
    const college: EducationRow = { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: null, gpa: null, startYear: null, endYear: null };
    const highSchool: EducationRow = { ...college, key: "high_school", level: "high_school", degree: null };
    expect(chooseDegreeOption(highSchool, ["GED (High School Equivalent)", "High School Diploma", "Bachelor's Degree"])).toBe("High School Diploma");
    expect(chooseDegreeOption(highSchool, ["GED", "High School/Secondary Diploma – Incomplete", "High School/Secondary Diploma – Complete"])).toBe("High School/Secondary Diploma – Complete");
    expect(chooseDegreeOption(highSchool, ["Some High School", "High School Diploma/GED"])).toBe("High School Diploma/GED");
    expect(chooseDegreeOption(highSchool, ["GED", "Bachelor's Degree"])).toBeNull();
    expect(chooseDegreeOption(highSchool, ["GED (High School Equivalent)"])).toBeNull();
    expect(chooseDegreeOption(highSchool, ["High School Equivalency", "Associate's Degree"])).toBeNull();
    expect(chooseDegreeOption(highSchool, ["Some College", "High School or Equivalent", "Bachelor's Degree"])).toBe("High School or Equivalent");
  });

  it("reads curly apostrophes as plain ones and returns the option as offered", () => {
    const college: EducationRow = { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: null, gpa: null, startYear: null, endYear: null };
    expect(chooseDegreeOption(college, ["Associate’s Degree", "Bachelor’s Degree", "Master’s Degree"])).toBe("Bachelor’s Degree");
    expect(bachelorKind("Bachelor’s of Arts")).toBe("arts");
    expect(bachelorKind("Bachelorʼs of Science")).toBe("science");
  });

  it("finds the option with the same name, never one that only contains it", () => {
    expect(sameNamedOption("UC Berkeley", ["University of California, Berkeley Extension", "University of California, Berkeley"])).toBe("University of California, Berkeley");
    expect(sameNamedOption("UC Berkeley", ["University of California, Berkeley Extension"])).toBeNull();
    expect(sameNamedOption("", ["Other"])).toBeNull();
  });

  it("compares school names by their words and picks a campus-only option exactly once", () => {
    expect(sameNameKey("University of California - Davis")).toBe(sameNameKey("UC Davis"));
    expect(sameNameKey("University of California, Davis")).toBe(sameNameKey("University of California - Davis"));
    expect(campusOption("University of Example, Springfield", ["Springfield", "Shelbyville", "Other"])).toBe("Springfield");
    expect(campusOption("UC Davis", ["Davis", "Irvine"])).toBe("Davis");
    expect(campusOption("Example State University", ["Example", "Other"])).toBeNull();
    expect(campusOption("University of Example, Springfield", ["Springfield", "springfield"])).toBeNull();
  });

  it("matches schools and fields by their words, not loose substrings", () => {
    const schools = ["Berkeley City College", "University of California, Berkeley", "University of California, Berkeley Extension", "University of California, Los Angeles"];
    expect(matchPromptOption("UC Berkeley", schools)).toBe("University of California, Berkeley");
    expect(matchPromptOption("Berkeley City College", schools)).toBe("Berkeley City College");
    expect(matchPromptOption("Northwind High School", schools)).toBeNull();
    expect(matchPromptOption("Computer Science", ["Computer Engineering", "Computer Science", "Computer Science and Engineering"])).toBe("Computer Science");
    expect(promptSearchTerms("UC Berkeley")).toEqual(["University of California, Berkeley", "UC Berkeley", "berkeley"]);
  });
});
