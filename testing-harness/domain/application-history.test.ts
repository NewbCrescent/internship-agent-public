import { describe, expect, it } from "vitest";

import {
  asksForAllSchools,
  asksForHighSchool,
  bachelorKind,
  campusOption,
  chooseDegreeOption,
  educationRowsForSection,
  fieldOfStudyCategoryOption,
  highSchoolPlaceOf,
  matchFieldOfStudyOption,
  matchPromptOption,
  namedSchoolRelation,
  planApplicationHistory,
  promptSearchTerms,
  sameNameKey,
  sameNamedOption,
  schoolsAttendedLines,
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

  it("tells whether a school a question names is the profile's school, another institution, or ambiguous (Track 57)", () => {
    const cases: Array<[string, string, "same" | "different" | "ambiguous"]> = [
      ["the Northwind Institute of Technology", "Example State University", "different"],
      ["Example State University", "example state university", "same"],
      ["UC Springfield", "University of California, Springfield", "same"],
      ["UC Springfield", "Northwind Institute of Technology", "different"],
      ["Example University", "Example State University", "ambiguous"],
      ["University of Example", "University of Example, Springfield", "ambiguous"],
      ["NIT", "Northwind Institute of Technology", "ambiguous"],
      ["NIT University", "Northwind Institute of Technology", "ambiguous"],
      ["nit university", "Northwind Institute of Technology", "ambiguous"],
      ["Northwind College", "Westfield", "ambiguous"]
    ];
    for (const [named, profileSchool, relation] of cases) {
      expect(namedSchoolRelation(named, profileSchool), `${named} / ${profileSchool}`).toBe(relation);
    }
  });

  it("matches schools and fields by their words, not loose substrings", () => {
    const schools = ["Berkeley City College", "University of California, Berkeley", "University of California, Berkeley Extension", "University of California, Los Angeles"];
    expect(matchPromptOption("UC Berkeley", schools)).toBe("University of California, Berkeley");
    expect(matchPromptOption("Berkeley City College", schools)).toBe("Berkeley City College");
    expect(matchPromptOption("Northwind High School", schools)).toBeNull();
    expect(matchPromptOption("Computer Science", ["Computer Engineering", "Computer Science", "Computer Science and Engineering"])).toBe("Computer Science");
    expect(promptSearchTerms("UC Berkeley")).toEqual(["University of California, Berkeley", "UC Berkeley", "berkeley"]);
  });

  it("takes Micron's general \"Bachelor's Level Degree\" and asks when two options fit equally (micron.wd1, 2026-11-25)", () => {
    const college: EducationRow = { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: null, gpa: null, startYear: null, endYear: null };
    const micron = ["Select One", "High School/ A levels / STPM/GED", "SPM / O levels / N levels", "Technical Certificate", "Technical / Professional Diploma",
      "Advanced Diploma/Associate's Level Degree", "Bachelor's Level Degree", "Master's Level Degree", "Doctorate's Level Degree", "Post Doctorate"];
    expect(chooseDegreeOption(college, micron)).toBe("Bachelor's Level Degree");
    expect(chooseDegreeOption({ ...college, degree: "B.S. Computer Science" }, micron)).toBe("Bachelor's Level Degree");
    expect(chooseDegreeOption(college, ["Bachelor of Arts", "Bachelor of Arts (BA)", "Bachelor's Degree"])).toBeNull();
    expect(chooseDegreeOption(college, ["Bachelor of Science", "Bachelor's Degree", "Bachelor's Level Degree"])).toBeNull();
  });

  it("matches a field of study that differs only by a plural ending, exactly once (micron.wd1, 2026-11-25)", () => {
    const micron = ["Applied Sciences", "Busin.computer sciences", "Computer sciences", "Data Science", "Engineering - Science/Plant", "Environmental Sciences",
      "Food Science", "L. Breve Scienze Dei Materiali", "L. Breve Scienze dell'Edu/Form", "L. Scienze Biologiche"];
    expect(matchFieldOfStudyOption("Computer Science", micron)).toBe("Computer sciences");
    expect(matchFieldOfStudyOption("Computer Science", ["Computer Sciences", "Computer Science"])).toBe("Computer Science");
    expect(matchFieldOfStudyOption("Computer Science", ["Computer Sciences", "Computers Science"])).toBeNull();
    expect(matchFieldOfStudyOption("Computer Science", ["Computer and Information Science"])).toBe("Computer and Information Science");
    expect(matchFieldOfStudyOption("Economics", ["Economic Development", "Business"])).toBeNull();
    expect(matchFieldOfStudyOption("Business", ["Busines", "Business Administration"])).toBe("Business Administration");
  });
});

describe("the high school only where a form asks for it (the candidate's rule, 2026-11-26)", () => {
  const college: EducationRow = {
    key: "college", school: "Example State University", level: "bachelor", degree: "B.A. Computer Science",
    fieldOfStudy: "Computer Science", gpa: null, startYear: 2025, endYear: 2028
  };
  const highSchool: EducationRow = {
    key: "high_school", school: "Northwind High School", level: "high_school", degree: null, fieldOfStudy: null, gpa: null, startYear: 2021, endYear: 2025
  };
  const place = { city: "Springfield", region: "Oregon", postalCode: "97477" };

  it("tells a high-school label from a degree or school label", () => {
    for (const label of ["High school", "Secondary school name", "High School / GED", "Name of your high-school", "High school diploma"]) {
      expect(asksForHighSchool(label), label).toBe(true);
    }
    for (const label of ["Degree / Diploma", "School", "Education", "Diploma"]) {
      expect(asksForHighSchool(label), label).toBe(false);
    }
  });

  it("tells an every-school question from a single-school one", () => {
    for (const label of ["Please list all schools you have attended", "List every college or university you attended", "All colleges and universities attended"]) {
      expect(asksForAllSchools(label), label).toBe(true);
    }
    for (const label of ["School attended", "High school", "Education"]) {
      expect(asksForAllSchools(label), label).toBe(false);
    }
  });

  it("gives an Education section the college only, a high-school section the high school, and an every-school section both", () => {
    expect(educationRowsForSection([college, highSchool], "Education")).toEqual([college]);
    expect(educationRowsForSection([college, highSchool], "High School")).toEqual([highSchool]);
    expect(educationRowsForSection([college, highSchool], "Education (list all schools attended)")).toEqual([college, highSchool]);
  });

  it("lists every school attended, the college first, only when both are saved", () => {
    expect(schoolsAttendedLines([highSchool, college], place)).toEqual([
      "Example State University, B.A. Computer Science, 2025-2028",
      "Northwind High School, Springfield, Oregon, 2021-2025"
    ]);
    expect(schoolsAttendedLines([college], place)).toBeNull();
    expect(schoolsAttendedLines([highSchool], place)).toBeNull();
    expect(schoolsAttendedLines([{ ...college, degree: null, endYear: null }, { ...highSchool, startYear: null }])).toEqual([
      "Example State University, 2025",
      "Northwind High School, 2025"
    ]);
  });

  it("reads the high school's place from the profile", () => {
    expect(highSchoolPlaceOf(null)).toEqual({ city: undefined, region: undefined, postalCode: undefined });
    expect(highSchoolPlaceOf({ ...CANDIDATE, highSchoolCity: "Springfield", highSchoolRegion: "Oregon", highSchoolPostalCode: "97477" }))
      .toEqual(place);
  });
});

describe("field-of-study category lists (Track 43)", () => {
  // Veeva's Lever list (2026-11-26).
  const VEEVA = [
    "Select...", "Business & Management", "Engineering (Non-Computer Science)", "Engineering – Computer Science & Technology",
    "Life Sciences & Health", "Physical Sciences", "Mathematics & Statistics", "Social Sciences", "Humanities & Liberal Arts",
    "Arts & Design", "Education", "Communications & Media", "Agriculture & Environmental Studies", "Law, Policy & Public Service", "Other"
  ];

  it("picks the category naming the field, never the option that negates it", () => {
    expect(fieldOfStudyCategoryOption("Computer Science", VEEVA)).toBe("Engineering – Computer Science & Technology");
    expect(fieldOfStudyCategoryOption("Mathematics", VEEVA)).toBe("Mathematics & Statistics");
    expect(fieldOfStudyCategoryOption("Physics", VEEVA)).toBeNull();
    // The containing rule this replaces picks the negated option.
    expect(matchPromptOption("Computer Science", VEEVA)).toBe("Engineering (Non-Computer Science)");
  });

  it("never picks Other, pauses on two options naming it, and prefers an exact option", () => {
    expect(fieldOfStudyCategoryOption("Computer Science", ["Other (Computer Science)", "Other than Computer Science", "Business"])).toBeNull();
    expect(fieldOfStudyCategoryOption("Computer Science", ["Computer Science & Engineering", "Applied Computer Science"])).toBeNull();
    expect(fieldOfStudyCategoryOption("Computer Science", ["Computer Science & Engineering", "Computer Science"])).toBe("Computer Science");
  });
});
