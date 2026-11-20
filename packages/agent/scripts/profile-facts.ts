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
 *     { "key": "eeo_gender", "value": "<one of: male | female | non_binary>" }
 *   ],
 *   "revoke": [{ "key": "<fact key>", "scope": { "kind": "global" } }]
 * }
 */
import { runProfileFacts } from "../src/profile-facts";

process.exitCode = await runProfileFacts(process.argv.slice(2));
