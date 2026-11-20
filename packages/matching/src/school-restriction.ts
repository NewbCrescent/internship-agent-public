import type { EligibilityFinding, JobPosting } from "@internship-agent/domain";

/**
 * Postings the employer states are for one school's students: a title led by
 * the school ("MIT- Software Engineer Intern"), a title or text saying
 * "<School> students only", or text saying the role is open only to students
 * at a school. A location that shares a school's name ("Columbia, MD") is
 * never read as a restriction because only these shapes count.
 */
type School = { label: string; pattern: string };

const SCHOOLS: School[] = [
  { label: "MIT", pattern: "MIT|Massachusetts Institute of Technology" },
  { label: "Stanford", pattern: "Stanford(?: University)?" },
  { label: "Carnegie Mellon", pattern: "CMU|Carnegie Mellon(?: University)?" },
  { label: "Harvard", pattern: "Harvard(?: University)?" },
  { label: "Princeton", pattern: "Princeton(?: University)?" },
  { label: "Yale", pattern: "Yale(?: University)?" },
  { label: "Columbia", pattern: "Columbia University" },
  { label: "Cornell", pattern: "Cornell(?: University)?" },
  { label: "Caltech", pattern: "Caltech|California Institute of Technology" },
  { label: "UCLA", pattern: "UCLA" },
  { label: "UC Berkeley", pattern: "UC Berkeley|U\\.?C\\.? Berkeley|University of California,? Berkeley|Berkeley" },
  { label: "Georgia Tech", pattern: "Georgia Tech|Georgia Institute of Technology" },
  { label: "UIUC", pattern: "UIUC|University of Illinois(?: Urbana-Champaign)?" },
  { label: "Waterloo", pattern: "(?:University of )?Waterloo" },
  { label: "UPenn", pattern: "UPenn|University of Pennsylvania" },
  { label: "Purdue", pattern: "Purdue(?: University)?" },
  { label: "NYU", pattern: "NYU|New York University" },
  { label: "UT Austin", pattern: "UT Austin|University of Texas at Austin" },
  { label: "University of Michigan", pattern: "UMich|University of Michigan" },
  { label: "USC", pattern: "USC|University of Southern California" },
  { label: "Duke", pattern: "Duke(?: University)?" },
  { label: "Northwestern", pattern: "Northwestern University" },
  { label: "Johns Hopkins", pattern: "Johns Hopkins(?: University)?" }
];

function statedSchool(posting: JobPosting): { school: School; excerpt: string } | null {
  for (const school of SCHOOLS) {
    const name = `(?:${school.pattern})`;
    const shapes = [
      { text: posting.title, pattern: new RegExp(`^\\s*${name}\\s*[-–—:|]`) },
      { text: posting.title, pattern: new RegExp(`\\b${name}\\s+(?:students?|candidates?)\\s+only\\b|\\(${name}(?:\\s+students?)?\\)`) },
      { text: posting.snapshot.normalizedText, pattern: new RegExp(`\\b(?:open|available|exclusive(?:ly)?)\\s+(?:only\\s+)?(?:to|for)\\s+(?:current\\s+)?(?:students|undergraduates|candidates)\\s+(?:at|from|of|enrolled at)\\s+(?:the\\s+)?${name}\\b`, "i") },
      { text: posting.snapshot.normalizedText, pattern: new RegExp(`\\b${name}\\s+students\\s+only\\b`, "i") }
    ];
    for (const shape of shapes) {
      const match = shape.pattern.exec(shape.text);
      if (match) return { school, excerpt: shape.text === posting.title ? posting.title : match[0] };
    }
  }
  return null;
}

/** A finding when the posting is for one school's students; null when it names none. */
export function checkSchoolRestriction(posting: JobPosting, candidateSchool: string | null): EligibilityFinding | null {
  const stated = statedSchool(posting);
  if (!stated) return null;
  if (!candidateSchool?.trim()) {
    return {
      subject: "school",
      requirementId: null,
      outcome: "UNKNOWN",
      reason: `The posting is for ${stated.school.label} students, and no school is recorded on the profile.`,
      statedExcerpt: null
    };
  }
  const attends = new RegExp(`\\b(?:${stated.school.pattern})\\b`, "i").test(candidateSchool);
  return attends
    ? { subject: "school", requirementId: null, outcome: "PASS", reason: `The posting is for ${stated.school.label} students, and you attend ${candidateSchool}.`, statedExcerpt: null }
    : {
        subject: "school",
        requirementId: null,
        outcome: "FAIL",
        reason: `The posting is for ${stated.school.label} students only, and your school is ${candidateSchool}.`,
        statedExcerpt: stated.excerpt.slice(0, 600)
      };
}
