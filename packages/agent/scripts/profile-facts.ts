/**
 * Writes the candidate's explicitly given answers as remembered facts
 * (source "user", provenance kind "profile"), validating the whole file
 * before anything is written. Protected answers (voluntary
 * self-identification) are printed only as "set", never echoed.
 *
 * Usage: pnpm profile:facts --profile real|demo [--set-file <facts.json>] [--dry-run]
 * Without --set-file it lists the current facts.
 *
 * File shape (placeholders, not real values):
 * {
 *   "facts": [
 *     { "key": "<fact key>", "scope": { "kind": "global" }, "value": "<true | false | text | YYYY-MM-DD>", "note": "<optional provenance>" },
 *     { "key": "willing_to_relocate", "scope": { "kind": "country", "code": "<ISO country>" }, "value": "<true | false>" },
 *     { "key": "previously_worked_here", "scope": { "kind": "company", "name": "<employer>" }, "value": "<true | false>" },
 *     { "key": "eeo_gender", "value": "<one of: male | female | non_binary>" },
 *     { "key": "willing_background_check", "value": <true | false> },
 *     { "key": "willing_to_relocate_at_own_expense", "scope": { "kind": "country", "code": "<ISO country>" }, "value": <true | false> },
 *     { "key": "eeo_sexual_orientation", "value": "<one of: heterosexual | gay | lesbian | bisexual | pansexual | asexual | queer>" },
 *     { "key": "eeo_transgender", "value": "<one of: transgender | not_transgender>" }
 *   ],
 *   "revoke": [{ "key": "<fact key>", "scope": { "kind": "global" } }]
 * }
 *
 * Also accepts the standard legal and background answers file (placeholders;
 * every key is required, unknown keys fail, and values print only as "set"):
 * {
 *   "us_citizen": <true | false>,
 *   "us_person_export_controls": "<option text, e.g. A United States citizen or national>",
 *   "security_clearance_eligible": <true | false>, "holds_security_clearance": <true | false>,
 *   "criminal_conviction": <true | false>, "government_debarment_or_exclusion": <true | false>,
 *   "non_compete": <true | false>,
 *   "non_solicitation": {
 *     "answer": <true | false>, "explanation": "<text that names no employer>", "ends": "<YYYY-MM-DD>",
 *     "name_former_employer": false, "combined_non_compete_or_non_solicit_question": <true | false>,
 *     "agreement_restricts_this_job": <true | false>, "confirmed": "<when and how the candidate confirmed it>"
 *   },
 *   "conflict_of_interest": <true | false>, "relative_government_official": <true | false>,
 *   "immediate_family_health_care_professional": <true | false>,
 *   "lives_within_50_miles_of_san_francisco": <true | false>,
 *   "salary_expectation": "<the rule in words; the coded rule uses the posting's stated pay>",
 *   "preferred_first_name": "<name>",
 *   "concerns_working_on_dod_projects": <true | false>
 * }
 *
 * Also accepts the high school's details file (placeholders; it fills only
 * details not yet saved, keeps a saved value that differs, refuses a school
 * other than the saved one, and prints detail names, never values):
 * {
 *   "highSchool": {
 *     "school": "<the saved high school's name>", "city": "<city>", "region": "<state>", "postalCode": "<ZIP code>",
 *     "startYear": "<YYYY>", "endYear": "<YYYY>", "source": "<where the candidate stated it>"
 *   }
 * }
 */
import { runProfileFacts } from "../src/profile-facts";

process.exitCode = await runProfileFacts(process.argv.slice(2));
