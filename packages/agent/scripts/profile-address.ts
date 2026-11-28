/**
 * Sets the candidate profile's mailing address (the profile page's address
 * fields) without the dashboard. The file names only the fields it changes;
 * unknown keys fail, an empty string clears a field, and the profile
 * schema's own limits apply. The save goes through the dashboard action's
 * service (updateCandidateProfile) under the pipeline lock. Only field names
 * are printed, never values.
 *
 * Usage: pnpm profile:address --profile real|demo [--list | --set-file <address.json> [--dry-run]]
 * Without --set-file (or with --list) it lists which address fields are set.
 *
 * File shape (placeholders, not real values; every key is optional):
 * {
 *   "addressLine1": "<street address>", "addressLine2": "<apartment or unit, or \"\" to clear>",
 *   "addressCity": "<city>", "addressRegion": "<state or region>",
 *   "addressPostalCode": "<postal code>", "addressCountry": "<country>"
 * }
 */
import { runProfileAddress } from "../src/profile-address";

process.exitCode = await runProfileAddress(process.argv.slice(2));
