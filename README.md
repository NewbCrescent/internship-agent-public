# Internship Agent

A local-first agent that finds internship postings, decides which ones fit, and
fills their application forms in a real browser, with a human in the loop.

## What it does

1. **Discovery.** Reads public GitHub internship lists (such as
   `SimplifyJobs/Summer2027-Internships`) and resolves each row through the job
   board's own public API (Greenhouse, Lever, Ashby, and others) to get the real
   posting text. Nothing is scraped around a login or a bot check.
2. **Deterministic rules.** Each posting is normalized into requirements that
   quote the posting's own text, then checked against hard eligibility rules
   (graduation window, degree level, location, work authorization when stated)
   and the candidate's application target (term, role, location).
3. **AI fit.** A configured model compares the posting with the candidate's
   allowed evidence and explains its judgment. Model output never becomes
   candidate truth.
4. **Form filling.** The browser worker (Playwright, a visible Chromium window
   by default) recognizes the application form and fills it deterministically
   from facts the candidate entered, with provenance. Anything it cannot answer
   from a saved fact, any sensitive or protected question, any consent box, and
   any CAPTCHA or site safeguard holds the run for the candidate. CAPTCHAs and
   access controls are never bypassed.
5. **Submission.** Final submission needs the candidate's explicit approval. An
   opt-in auto-submit policy (`INTERNSHIP_AGENT_AUTO_SUBMIT=1` with a target
   term) may submit only runs with no hold of any kind, on postings the target
   accepts, within a daily cap; it records itself as the policy's approval.

A Next.js dashboard shows postings, match reports, application packages, runs
and their holds, and the candidate profile and memory.

## Setup

Requires a Node.js with the built-in `node:sqlite` module (developed on Node 24)
and pnpm 10.

```bash
pnpm install
cp .env.example .env    # every setting is optional and documented there
pnpm seed:dev           # fictional demo data
pnpm dev                # dashboard on http://localhost:3000
```

Useful commands:

```bash
pnpm pipeline:run       # one unattended pass: discovery, matching, preparation, runs
pnpm pipeline:status    # what the last pass did
pnpm verify:fast        # deterministic suites, no network or persistent state
pnpm verify:feature -- browser
pnpm agent:finish browser   # lint, typecheck, scoped suites, production build
```

`AGENTS.md`, `ProjectStructure.md`, and `TECHNICAL.md` describe the
architecture, the test harness, and every command.

## Privacy model

- Candidate data stays on your machine: the profile, facts, resumes,
  application artifacts and history, and the authenticated browser profile
  live in the Git-ignored `data/` directory (SQLite) by default.
- Candidate details are sent to the model you configure (`MODEL_API_*`) for
  classification, fit, and drafting, and to the application forms you (or your
  opt-in auto-submit policy) approve. Secrets, tokens, passwords, and browser
  session state are never put in prompts, logs, or reports.
- Optional integrations you configure in `.env` (Discord notices, a Gmail
  inbox read for confirmation and security-code emails, a GitHub token for
  higher API limits) talk only to those services.
- Only fictional fixtures and seed records are checked into this repository.
