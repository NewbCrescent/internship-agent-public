import { describe, expect, it } from "vitest";

import { DeterministicQuestionMapper } from "@internship-agent/agent";
import { planAutofill, recognizeForm, type FieldResolution, type RawControl } from "@internship-agent/browser";
import type { QuestionContext } from "@internship-agent/domain";

/**
 * Track 79 regression corpus: question wordings and option lists captured from the held runs of 2026-11-27 (company
 * names replaced by fictional ones; every candidate value here is fictional). Each mapper row states the key the
 * deterministic mapper must give (or that it must stay UNMAPPED / AMBIGUOUS), and each planner row the action and
 * option the planner must take from a fictional profile and fictional saved answers, so a later mapper or planner
 * change cannot silently undo these answers or start answering the ones that must stay paused.
 */

const mapper = new DeterministicQuestionMapper();
const US: QuestionContext = { postingCountryCode: "US", companyName: "Fixture Co" };

type MapperRow = [question: string, expected: string, context?: QuestionContext];

const MAPPER_ROWS: MapperRow[] = [
  // Graduation date.
  ["When are you graduating? Please include month and year.", "graduation_date"],
  ["What semester are you on track to graduate?", "graduation_date"],
  ["What is your anticipated graduation year?", "graduation_date"],
  ["What is your ancitipated graduation season?", "graduation_date"],
  ["What year do you graduate?", "graduation_date"],
  ["If you are enrolled in a university or college, what year do you graduate?", "graduation_date"],
  ["If you are currently a student, when do you expect to graduate or complete your program? (Select the closest date.)", "graduation_date"],
  ["What is your expected date of graduation?", "graduation_date"],
  ["What is your anticipated graduation month and year?", "graduation_date"],
  ["When are you expected to graduate? (MM/YYYY)", "graduation_date"],
  ["Will you be graduating before September 2027?", "graduation_date"],
  ["Is your expected graduation date in 2028 or later?", "graduation_date"],
  ["What is your expected graduation date for your current degree program?", "graduation_date"],
  // How heard, start and end dates.
  ["Where did you first hear about this job?", "how_heard"],
  ["When do you plan on ending your internship?", "available_end_date"],
  ["When are you able to join Fixture Co as an intern? (12 week minimum)", "available_start_date"],
  ["On what date would you be available for work?", "available_start_date"],
  ["On what date could you start?", "available_start_date"],
  // On-site work.
  ["Are you open to working out of our Fixture Town (FT) Office 5 Days a Week?", "work_arrangement"],
  ["If hired, can you work from our office in Fixture City, Utah, 3 days a week?", "work_arrangement"],
  ["Are you willing to work from our Headquarters in Fixture City, CA, full-time, 5 days a week?", "work_arrangement"],
  ["Onsite Availability", "work_arrangement"],
  // Sponsorship and country words.
  ["Will you now or in the future require our company to file a petition or application for employment - based immigration status on your behalf?", "requires_sponsorship", US],
  ["Will you need to be sponsored for a work visa by Fixture Devices – either now or in the future – to work for Fixture Devices?", "requires_sponsorship", US],
  ["Are you legally authorized to work in the United Kingdom?", "authorized_to_work"],
  ["Are you authorised to work in Hong Kong?", "authorized_to_work"],
  // Enrollment, scores.
  ["Are you currently enrolled in an undergraduate or graduate degree program?", "enrolled_full_time"],
  ["Provide your best result on SAT:", "sat_score"],
  ["Provide your best result on ACT:", "act_score"],
  ["SAT Score", "sat_score"],
  ["ACT Score", "act_score"],
  ["Select your Standardized Test score type:", "sat_score"],
  // Must stay unmapped or ambiguous.
  ["Are you open to starting full-time immediately after your internship? (either graduated or willing to take time off)", "UNMAPPED"],
  ["SAT or ACT Score", "UNMAPPED"],
  ["Still Student?", "UNMAPPED"],
  ["What is your current academic year?", "UNMAPPED"],
  ["What will your current academic standing be at the time this internship begins?", "UNMAPPED"],
  ["What is your highest level of education completed?", "UNMAPPED"],
  ["Are you able to work out of Fixture City?", "UNMAPPED"],
  ["Do you require sponsorship?", "AMBIGUOUS"],
  ["Have you completed your junior year of study (i.e., are you entering your senior year) or are you a graduate student?", "UNMAPPED"]
];

describe("held-question corpus: mapper (Track 79)", () => {
  it.each(MAPPER_ROWS)("%s → %s", async (question, expected, context) => {
    const mapped = await mapper.map(question, context ?? {});
    if (expected === "UNMAPPED" || expected === "AMBIGUOUS") expect(mapped.status).toBe(expected);
    else expect(mapped).toMatchObject({ status: "MAPPED", key: expected });
  });
});

const TODAY = "2026-11-27";
const GRADUATION = "2028-05-15";
const PROFILE = {
  fullName: "Avery Example", linkedinUrl: "https://www.linkedin.com/in/avery-example", githubUrl: "https://github.com/avery-example",
  portfolioUrl: "https://avery.example", addressLine1: "1 Fixture Way", fieldOfStudy: "Computer Science", gpa: "3.584"
};
const EDUCATION = {
  school: "Example State University", degree: "B.A. Computer Science",
  graduation: { date: GRADUATION, basis: { kind: "fact", key: "graduation_date", scope: "global" } as const }
};

const resolved = (key: string, value: boolean | string): FieldResolution =>
  ({ status: "RESOLVED", key, scope: "global", display: typeof value === "boolean" ? (value ? "Yes" : "No") : value, value });

type PlannerRow = [name: string, control: RawControl, resolution: FieldResolution | null, action: string, value?: string];

const field = (tag: RawControl["tag"], label: string, options?: string[], type?: string): RawControl =>
  ({ tag, id: "q", label, required: true, ...(type ? { type } : {}), ...(options ? { options } : {}) });
const group = (label: string, options: string[]): RawControl => ({ tag: "input", type: "checkbox", widget: "checkbox-group", id: "q", label, required: true, options });

const PLANNER_ROWS: PlannerRow[] = [
  ["LinkedIn Profile URL:", field("input", "LinkedIn Profile URL:", undefined, "text"), null, "fill", PROFILE.linkedinUrl],
  ["LinkedIn Profile textarea", field("textarea", "LinkedIn Profile"), null, "fill", PROFILE.linkedinUrl],
  ["Github Link", field("input", "Github Link", undefined, "text"), null, "fill", PROFILE.githubUrl],
  ["Portfolio", field("input", "Portfolio", undefined, "text"), null, "fill", PROFILE.portfolioUrl],
  ["Home Address Line 1", field("input", "Home Address Line 1", undefined, "text"), null, "fill", PROFILE.addressLine1],
  ["GPA one-decimal list", field("select", "Whats your current GPA?", ["4.0", "3.9", "3.8", "3.7", "3.6", "3.5", "3.4"]), null, "choose", "3.5"],
  ["GPA threshold list", field("select", "GPA (undergraduate)", [">4.0", "4.0+", "3.7+", "3.5+", "3.2+", "3.0+", "<3.0"]), null, "choose", "3.5+"],
  ["graduation month pair", field("select", "When are you graduating?", ["December 2027", "May/June 2028", "December 2028"]), resolved("graduation_date", GRADUATION), "choose", "May/June 2028"],
  ["graduation month span", field("select", "What is your expected date of graduation?", ["July – December 2027", "January – June 2028", "July – December 2028"]), resolved("graduation_date", GRADUATION), "choose", "January – June 2028"],
  ["graduation open year", field("select", "What year do you graduate?", ["2026 or earlier (already graduated or graduating this year)", "2027", "2028", "2029 or later"]), resolved("graduation_date", GRADUATION), "choose", "2028"],
  ["graduation checkbox terms", group("What is your expected graduation date for your current degree program?", ["Spring 2027", "Winter 2027", "Spring 2028", "Fall 2028"]), resolved("graduation_date", GRADUATION), "choose", "Spring 2028"],
  ["graduation before", field("select", "Will you be graduating before September 2028?", ["Yes", "No"]), resolved("graduation_date", GRADUATION), "choose", "Yes"],
  ["graduation 2028 or later", field("select", "Is your expected graduation date in 2028 or later?", ["Yes", "No"]), resolved("graduation_date", GRADUATION), "choose", "Yes"],
  ["graduation MM/YYYY", field("input", "When are you expected to graduate? (MM/YYYY)", undefined, "text"), resolved("graduation_date", GRADUATION), "fill", "05/2028"],
  ["age sentence", field("select", "Are you at least 18 years of age?", ["Yes, I am at least 18 years of age.", "No, I am not at least 18 years of age."]), resolved("age_18_or_older", true), "choose", "Yes, I am at least 18 years of age."],
  ["previous employment statement", field("select", "Have you previously worked at Fixture Co?", ["I have previously been employed at Fixture Co", "I have not previously been employed at Fixture Co"]), resolved("previously_worked_here", false), "choose", "I have not previously been employed at Fixture Co"],
  ["visa class None", field("select", "Which visa type will you require?", ["OPT", "H1B", "TN", "None", "Other"]), resolved("requires_sponsorship", false), "choose", "None"],
  ["degree level", field("select", "What degree are you currently enrolled in?", ["PhD", "Master's", "Bachelor's", "Other"]), null, "choose", "Bachelor's"],
  ["U.S. person Yes/No", field("select", "As a result of the work performed by Fixture Space, all eligible candidates must be a U.S. Person or able to obtain an export license.", ["Select One", "Yes", "No"]), resolved("us_person_export_controls", "U.S. citizen"), "choose", "Yes"],
  ["SAT bucket out of 1600", field("select", "SAT Score", ["Did not take/Do not recall", "1600 out of 1600", "1550-1599 out of 1600", "1500-1549 out of 1600"]), resolved("sat_score", "1520"), "choose", "1500-1549 out of 1600"],
  ["test score type", field("select", "Select your Standardized Test score type:", ["ACT", "SAT", "Other"]), resolved("sat_score", "1520"), "choose", "SAT"],
  // Must stay paused.
  ["highest level completed", field("select", "What is your highest level of education completed?", ["Some High School", "High School Diploma/GED", "Some College", "Associate Degree", "Bachelor Degree"]), null, "pause"],
  ["academic year list", field("select", "What is your current academic year?", ["Freshman", "Sophomore", "Junior", "Senior", "Graduate Student"]), null, "pause"],
  ["relocation qualifier", group("Are you open to working out of our Fixture Town Office 5 Days a Week?", ["Yes, but require relocation", "No"]), resolved("work_arrangement", true), "pause"],
  ["combined SAT or ACT", field("input", "SAT or ACT Score", undefined, "text"), null, "pause"],
  ["citizen-only requirement, permanent resident", field("select", "Applicant must be a U.S. citizen. Do you meet this requirement?", ["Select One", "Yes", "No"]), resolved("us_person_export_controls", "I am a lawful permanent resident of the United States"), "pause"]
];

describe("held-question corpus: planner (Track 79)", () => {
  it.each(PLANNER_ROWS)("%s", (_name, control, resolution, action, value) => {
    const form = recognizeForm("https://job-boards.greenhouse.io/fixture/jobs/79", "Apply", [control]);
    const result = planAutofill(form, {
      profile: PROFILE,
      resolutions: new Map(resolution ? [["q", resolution]] : []),
      packageAnswers: [],
      variantId: null,
      education: EDUCATION,
      standing: { acceptDataConsent: false, signAttestations: false, today: TODAY }
    });
    const decision = result.decisions[0]!;
    expect(decision.action).toBe(action);
    if (value !== undefined) expect(decision.value).toBe(value);
  });
});
