/**
 * Lists or stores the candidate's uploaded resumes. Applications send the
 * channel's current upload byte for byte: `default` on default-profile
 * applications, `handshake_internal` on the 2029 profile (Handshake Quick
 * Apply / Apply, or a form that asks for a transcript).
 *
 * Usage: pnpm profile:resume --profile real|demo [--channel default|handshake_internal --file <pdf> [--label <text>] [--dry-run]]
 * Without --file it lists the current uploads with their page count and SHA-256.
 *
 * Example (placeholders): pnpm profile:resume --profile demo --channel default --file <path/to/resume.pdf> --label "<label>"
 */
import { runProfileResume } from "../src/profile-resume";

process.exitCode = await runProfileResume(process.argv.slice(2));
