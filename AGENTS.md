# AGENTS.md — Internship Agent

This is the authoritative guide for agents contributing to this repository.

## Before any change

Read this file and `ProjectStructure.md` in full. Read the status and the task-relevant sections of `TECHNICAL.md`; do not load unrelated history or generated artifacts. Discover files with `rg --files` and trace symbols with scoped `rg -n` searches.

For non-trivial work, present a file-level plan and a **Harness impact** assessment before editing. Apply the standing authorization below and run `pnpm agent:doctor --feature <feature>` before implementation. Before handoff, run the smallest feature gate and then `pnpm agent:finish <feature>` when its prerequisites are available.

## Product invariants

- Never invent candidate facts, credentials, dates, metrics, authorization status, demographic data, or preferences.
- Candidate facts carry provenance. Generated or inferred content never silently becomes candidate truth.
- Preferences are not application answers.
- Sensitive facts require explicit user input. Protected demographic answers and application-specific attestations are never inferred: statements of fact about the candidate (citizenship, U.S.-person or export-control eligibility, government or DoD eligibility, debarment, conflicts of interest, criminal history, prior employment, security clearance, non-compete status) come only from the candidate's saved answers. Two explicit candidate settings (2026-11-20) let the agent accept or sign, and log on the timeline with the exact text, statements whose truth does not depend on an unknown fact: `INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT=1` accepts data-processing, data-retention, and privacy-policy consent that is a condition of applying, and `INTERNSHIP_AGENT_SIGN_ATTESTATIONS=1` signs accuracy certifications, electronic signatures (the saved legal name and today's date), acknowledgments (at-will, privacy or applicant notice, temporary internship, equal-opportunity statement), and background-check, drug-test, reference-check, and arbitration authorizations. Marketing and newsletter opt-ins are never accepted. Protected voluntary self-identification answers (gender, race or ethnicity, veteran status, disability) are reused only when the candidate explicitly saved them (`pnpm profile:facts`, at the candidate's request on 2026-11-19), only in voluntary self-identification / EEO questions where exactly one offered option matches; they never reach a model, logs, notices, or reports, and stay local. Answers given for a single run are never stored.
- Context-specific facts require an exact compatible scope; a Seattle answer does not answer an Austin question.
- Candidate PII, authenticated browser state, application artifacts, and history remain local by default.
- Final application submission requires explicit human approval, except under the candidate's opt-in auto-submit policy (`INTERNSHIP_AGENT_AUTO_SUBMIT=1` with a target term; the candidate chose it on 2026-11-17). That policy submits only runs `autoSubmitBlockers` finds clean (no pause, safeguard, voice draft, kept attachment, or unrecognized site) on postings the target judges `apply` (including eligible needs-review postings whose only open items are unverified skill, experience, or degree-wording requirements, never a failed, graduate-level, or statement-of-fact one, when their current AI fit meets the auto-submit bar; the candidate approved this on 2026-11-24), within the configured daily cap (set `INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP=unlimited` to remove the daily cap) and per-company limits (at most `INTERNSHIP_AGENT_COMPANY_CAP` automatic applications per company per target term, default 2, and one graduation profile per company); statements accepted or signed under the two standing consent and attestation settings above do not hold a run (the candidate's opt-in, 2026-11-20: "have the app sign legal statemetns"); it logs itself as the policy's approval, never as the candidate's, and manual checklist mode always turns it off. Widening what it may submit is a plan-and-approve change.
- Do not bypass CAPTCHAs, access controls, or site safeguards.

## Agent integrity and scope

- Use the global manager–worker pipeline for code and configuration changes where it applies. The main session owns scope, approvals, checkpoints, and final verification, and must directly review material evidence before reporting the result.
- State what was actually verified; do not call a plan or an unrun check complete.
- Modify only files required by the approved scope. Note unrelated issues without fixing them.
- Never rewrite history, force-push or otherwise force Git operations, push to `main`, or hand-edit `.git/`. You may push your own feature branch to `origin` and open a pull request against `main`.
- Never write real secrets or PII to tracked files. `.env.example` may contain names and placeholders only.
- Calls to the configured `MODEL_API_*` model are approved for agent work and may include the candidate's personal details (profile, resume entries, preferences, posting context). Never send secrets (API keys, tokens, passwords, session cookies, authenticated browser state) or identifiers such as the student ID, and never write them to prompts, logs, reports, or tracked files.
- Other paid-provider calls, hosted writes, and destructive database operations still need explicit approval. Making the product send candidate PII to a model by default is a plan-and-approve change.

## Architecture

Maintain this application flow:

```text
page.tsx (server reads and rendering)
  -> actions.ts (server mutations and input validation)
    -> packages/agent or another domain service
      -> packages/db repositories
```

- Components contain presentation and interaction, not database logic.
- Pages and actions do not issue SQL directly.
- Route handlers are thin wrappers for external HTTP consumers, webhooks, or streams; internal UI reads do not need an API layer.
- Shared runtime schemas and safety policy live in `packages/domain`.
- SQLite access and migrations live only in `packages/db`.
- Semantic question mapping and memory orchestration live in `packages/agent`.
- Use the default Node.js runtime for SQLite-backed routes and pages.
- Client Components must receive serializable props and cannot be async.
- TypeScript strict mode is required. Avoid `any`; validate untrusted input with Zod.

## Planning and decisions

The user grants standing approval for in-scope implementation plans, code, tests, documentation, routine verification, and routine runtime fixes. Proceed after presenting the required plan without requesting approval again. Explicit limits, later revocations, and specific external actions the user withheld still apply. Follow the product invariants and separate approval requirements in this file, including the requirements for sensitive facts, application submissions, and site safeguards.

Start triage as soon as the user or an automated report flags an issue, or you discover one. Start the manager–worker repair pipeline for confirmed, reproducible, in-scope defects under standing approval. If a finding requires user input or external confirmation, keep that item open and continue other authorized work. Reopen triage on an existing finding when new evidence or a status change warrants it. Verify an unconfirmed submission's outcome before considering a retry to avoid duplicate applications.

For multi-file or architectural changes, the plan must list files, contracts, dependencies, data changes, verification, and stop-and-ask items. Reassess scope if implementation requires a materially different schema, dependency, external service, privacy policy, or product behavior. Update the plan for changes within the standing authorization and ask for approval when the revised work exceeds it or needs separate approval under this file.

Keep commits single-purpose if the user asks for commits. Push only feature branches; changes reach `main` through pull requests the user merges.

## Testing harness evolution

The harness is a product capability. Every non-trivial feature plan states:

- the existing suites that exercise it;
- reusable scenarios or safety invariants to add;
- the smallest command that proves the change;
- any boundary that cannot be automated.

Register new or renamed commands in `testing-harness/manifest.mjs` with feature labels, tier, prerequisites, network use, mutations, timeout, and report prefixes. Prefer the nearest suite over one-off scripts.

Tiers:

- `fast`: deterministic schemas, mapping, and pure logic; no persistent state or network.
- `local`: temporary local SQLite integration; never touches the user's normal database.
- `browser`: a server owned by the verification process plus disposable local data.
- `benchmark`: explicit, versioned evaluation; never selected implicitly.

Synthetic fixtures prove contracts, not real-world accuracy. Model output must never become ground truth without human review.

## Verification and bug fixes

Use `pnpm agent:verify` for change-aware checks or `pnpm verify:feature -- <feature>` for a scoped gate. `pnpm agent:finish <feature>` performs preflight, quiet lint, typecheck, scoped verification, a production build, and `git diff --check`.

For bugs: reproduce, isolate the cause, plan, verify the plan against the reproduction, then prove the fix with the smallest reusable regression. If a real-path check is impossible, state the boundary instead of implying coverage.

Browser verification must start and stop its own server on a dedicated port and use a temporary data directory. Never kill or reuse a server owned by the user.

## Documentation discipline

Keep `TECHNICAL.md` and `ProjectStructure.md` aligned with structural, schema, workflow, and command changes. Record confirmed gaps in `BUGS.md`; do not maintain competing bug lists.
