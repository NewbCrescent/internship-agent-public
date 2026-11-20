# Internship Agent — Project Context & Milestones

> Codex handoff: read this document before implementing features. Treat it as the current product/architecture brief. Prefer completing milestones in order and keep every milestone runnable and demoable.

## 1. Product vision

Build a local-first internship application agent for a single candidate. It should discover or ingest internship listings (starting with Handshake), determine hard eligibility and fit, retrieve truthful supporting evidence from the candidate profile and GitHub repositories, prepare tailored application materials, verify every factual claim, ask the candidate only when needed, and use local browser automation to complete applications after human review.

The localhost dashboard is the control plane. The browser agent is a worker.

The target experience is:

1. An internship enters the system.
2. The agent parses eligibility, requirements, preferences, location, compensation, and application type.
3. The system rejects obvious bad fits and ranks plausible opportunities.
4. Relevant candidate/GitHub evidence is retrieved.
5. A tailored application package is written.
6. A separate verification step checks generated factual claims against approved evidence.
7. The dashboard presents the application for review.
8. The browser agent fills the application using known facts and prepared materials.
9. Unknown or ambiguous questions pause the workflow and ask the candidate.
10. The candidate can optionally choose **Remember this answer**.
11. Final submission has an explicit human approval boundary in v1.
12. The exact submitted resume, answers, links, and event history are persisted.

This is intentionally not a blind mass-application bot. Optimize for expected interview value per minute of candidate attention, not raw application count.

## 2. Non-negotiable principles

### Truth and provenance

- Never invent experience, credentials, dates, metrics, skills, authorization status, demographic information, or preferences.
- A professional factual claim may be used only if it comes from an explicit candidate fact or verified evidence.
- Generated writing may be creative about presentation, never about facts.
- Claims should retain provenance so a user can inspect why the system believes them.
- If a generated metric conflicts with evidence (for example, `15x` versus an evidenced `~10x`), verification must fail and the text must be regenerated or reviewed.

### Human control

- Final application submission requires explicit approval in v1.
- Unknown, ambiguous, sensitive, or consequential questions should pause and ask the candidate.
- The system may suggest preference changes based on outcomes, but must not silently alter candidate preferences.
- Do not infer protected/demographic data.

### Local-first privacy

- Candidate PII, resumes, application answers, authenticated browser state, and application history remain local by default.
- Do not introduce cloud infrastructure merely for convenience in early milestones.
- Secrets belong in environment variables/local secret storage and must never be committed.

### Cost discipline

- Browser mechanics and deterministic transforms should not use an LLM.
- Use cheap models for high-volume extraction/classification/verification.
- Escalate to stronger models only for tasks where better reasoning/writing is valuable.
- Persist results and analyze deltas rather than repeatedly re-processing the same GitHub repository or job.

## 3. Initial technology choices

- Monorepo: pnpm workspaces + Turborepo.
- Dashboard: Next.js App Router + TypeScript, localhost-first.
- UI: Tailwind/shadcn may be added when useful; avoid premature UI dependency sprawl.
- Persistence: SQLite initially. This is a single-user local application.
- Runtime schemas: Zod.
- Browser automation: Playwright, using the candidate's local authenticated browser/session where appropriate.
- GitHub: GitHub API plus selective repository/file inspection.
- AI: provider-agnostic structured-output layer. Do not couple domain code directly to one vendor SDK.
- Live dashboard progress: SSE is likely sufficient initially; use WebSockets only if bidirectional real-time requirements justify them.
- Generated application artifacts: local filesystem initially.

## 4. Monorepo boundaries

```text
internship-agent/
├── apps/
│   └── dashboard/          # Local control center
├── packages/
│   ├── domain/             # Shared schemas/types/state machines
│   ├── db/                 # SQLite persistence
│   ├── agent/              # Orchestration/model routing/budgets
│   ├── browser/            # Handshake + ATS execution
│   ├── github/             # Repository evidence ingestion
│   ├── jobs/               # Job parsing/normalization
│   ├── matching/           # Eligibility and fit scoring
│   ├── writer/             # Application/resume writing
│   ├── verifier/           # Claim verification/provenance
│   └── resume/             # Resume variants/rendering/snapshots
└── data/                   # Local runtime data; do not commit PII
```

Package boundaries can evolve, but avoid collapsing the entire agent into the Next.js app.

## 5. Core domain concepts

At minimum the system will eventually need these concepts:

- `Candidate`
- `CandidateFact`
- `CandidatePreference`
- `Experience`
- `Project`
- `Evidence`
- `Claim`
- `ClaimEvidence`
- `Company`
- `Job`
- `JobRequirement`
- `JobMatch`
- `Application`
- `ApplicationAnswer`
- `ApplicationDocument`
- `ApplicationEvent`
- `Resume`
- `ResumeBullet`

Important relationship:

```text
Application
  -> exact Resume submitted
    -> Resume bullets
      -> Claims
        -> Claim evidence
```

Months later the candidate should be able to answer, "What exactly did I tell this company, and why did the agent believe each factual statement?"

## 6. Application state machine

Use an explicit application/job workflow rather than loosely related booleans.

```text
DISCOVERED
  -> ANALYZING
  -> NOT_QUALIFIED
  -> QUALIFIED
  -> PREPARING
  -> NEEDS_INPUT
  -> READY_FOR_REVIEW
  -> APPROVED
  -> APPLYING
  -> SUBMITTED
  -> INTERVIEW | REJECTED | OFFER | WITHDRAWN
```

Not every application must traverse every state, but state transitions should be auditable through `ApplicationEvent` records.

## 7. The Remember feature

The candidate should not repeatedly answer the same semantic question.

Example:

```text
Question: Are you willing to relocate?
Candidate: Yes
[x] Remember this answer
```

Persist the semantic fact, not only the literal question text:

```ts
{
  key: "willing_to_relocate",
  value: true,
  source: "user",
  confidence: 1,
  sensitive: false,
  rememberedAt: "..."
}
```

A later question such as `Would you consider relocating for this role?` should map to the same concept. The mapping may use a cheap classifier; the stored value remains authoritative.

Rules:

- User-supplied remembered facts are authoritative until changed.
- Verified repository/profile facts may support professional claims.
- LLM inference alone must never silently become candidate truth.
- Work authorization, legal attestations, protected/demographic data, and other sensitive answers must come from explicit candidate data or direct user input.
- When an answer is context-specific (for example, relocation to a particular city), use an appropriately scoped key instead of over-generalizing.

## 8. GitHub evidence engine

GitHub is not just a link collection. Convert relevant repository content into an evidence store.

Example project evidence might contain:

```text
Project: llama2c-m1-max-performance

C                       verified
ARM                     verified
NEON SIMD               verified
OpenMP                  verified
Multithreading          verified
Performance profiling   verified
~10x speedup            verified
```

Each important claim should point back to evidence such as README sections, relevant source files, benchmark output, or other approved candidate material.

Analyze repositories incrementally. Record commit/SHA information and re-process changed material rather than re-reading entire repositories for every application.

## 9. Job understanding and matching

Separate hard eligibility from fit.

Hard eligibility examples:

- student status
- degree constraints
- graduation window
- work authorization when explicitly stated
- required location/availability constraints

Fit examples:

- technical skill overlap
- strength/relevance of experience evidence
- candidate role preferences
- preferred qualifications
- domain interest

A missing preferred skill such as CUDA should reduce fit, not incorrectly mark the candidate ineligible.

Fit scoring must remain explainable. The dashboard should display reasons for a score, not just a number.

## 10. AI architecture and budget

Consumer ChatGPT/Claude subscriptions should not be assumed to cover API usage. API usage is separately billed.

The candidate is comfortable with roughly **$20-$40/month** for this project during an active internship search.

As of 2026-09-22, example standard API pricing included:

- OpenAI GPT-5.6 Luna: $0.20/M input, $1.20/M output.
- OpenAI GPT-5.6 Terra: $2/M input, $12/M output.
- OpenAI GPT-5.6 Sol: $4/M input, $20/M output.
- OpenAI GPT-6 Astra: $10/M input, $50/M output.
- Anthropic Claude Sonnet 5: $2/M input, $10/M output.
- Anthropic Claude Opus 5: $5/M input, $25/M output.

Pricing changes. Verify official current pricing before hard-coding routing economics.

Current official pricing references at time of writing:

- https://developers.openai.com/api/docs/pricing
- https://platform.claude.com/docs/en/about-claude/pricing

Desired provider abstraction should express task/tier intent rather than littering model IDs throughout the codebase. Conceptually:

```ts
model.complete(task, {
  tier: "cheap" | "standard" | "frontier",
});
```

Likely routing strategy:

- Cheap: job extraction, deduplication, classification, simple claim checks, semantic mapping of remembered answers.
- Standard: detailed match analysis, evidence selection, most application answers, resume selection.
- Frontier: only high-value/difficult final writing or reasoning.

Add cost accounting early enough that each model call can eventually be attributed to a job/application. A later dashboard should support a monthly budget, per-job cost, and frontier-escalation policy.

## 11. Browser automation approach

Do not use an expensive multimodal LLM to move the mouse through routine forms when deterministic browser automation can do the work.

Playwright should handle:

- navigation
- DOM inspection
- text entry
- select/checkbox/radio controls
- document upload
- deterministic Next/Continue actions
- confirmation detection

The AI layer should handle semantic ambiguity, unfamiliar questions, form interpretation where deterministic mapping fails, and exceptional flows.

Start with Handshake-hosted applications. Handshake also supports `Apply Externally`, which can redirect to arbitrary employer ATSs. External ATS support is deliberately a later milestone.

Do not attempt to bypass CAPTCHAs, bot protections, access controls, or other safeguards. Respect current site terms/policies and use the candidate's authorized session.

## 12. Dashboard product surface

Primary pages:

1. `Overview` — agent state and high-level pipeline counts.
2. `Jobs` — discovered/analyzed opportunities and ranking.
3. `Review Queue` — completed application packages awaiting candidate action.
4. `Applications` — permanent application tracker.
5. `Profile` — candidate facts/preferences and Remember management.
6. `Evidence` — projects, GitHub sync, verified/rejected claims.
7. `Analytics` — later milestone; outcomes, conversion, resume variants, cost.
8. `Settings` — model providers, API budgets, automation/approval policies.

For every submitted application, retain:

- source/Handshake URL
- external ATS URL when applicable
- optional company careers URL
- job description snapshot
- fit analysis
- exact resume/document version
- exact submitted answers
- timestamps/event history
- AI cost attribution when available

## 13. Milestones

### Milestone 0 — Monorepo and foundations

Deliver:

- pnpm workspace + Turborepo
- Next.js TypeScript dashboard
- SQLite persistence package
- Zod shared domain schemas
- package/module boundaries listed above
- logging/config conventions
- environment/secrets convention
- unit-test infrastructure before significant domain logic arrives
- seed/dev data path

Exit criteria:

- `pnpm dev` launches the dashboard.
- `pnpm build` and type checking pass.
- Dashboard can eventually read/write one seeded internship through the persistence layer (finish this before declaring M0 complete).

### Milestone 1 — Candidate profile + Remember

Deliver:

- editable candidate profile
- preferences (role types, locations, etc.)
- typed `CandidateFact` persistence
- remembered-answer UI
- semantic mapping from a new question to known fact keys
- sensitive/context-specific fact handling

Exit criteria:

- A known application question can be answered from memory with provenance.
- An unknown question is surfaced to the candidate.
- Candidate can choose to remember the answer and reuse it later.

### Milestone 2 — GitHub evidence engine

Deliver:

- GitHub repository ingestion
- relevant README/source/metadata extraction
- structured project/skill/claim evidence
- provenance links into source material
- allow/question/reject controls
- incremental update strategy using repo state/SHA

Exit criteria:

- At least one real repository produces a useful verified project profile.
- Important extracted claims can be traced to source evidence.

### Milestone 3 — Job ingestion and understanding

Deliver:

- ingest a provided Handshake job/page or supplied posting content
- normalized job schema
- hard requirements versus preferred qualifications
- technologies, locations, compensation when present
- graduation/work-authorization constraints when explicit
- application type/source URLs

Exit criteria:

- Several structurally different real postings normalize reliably to one schema.

### Milestone 4 — Eligibility + match engine

Deliver:

- deterministic hard eligibility checks where possible
- explainable fit scoring
- candidate preference weighting
- evidence-backed skill/experience matching
- explicit missing-preference versus failed-requirement distinction

Exit criteria:

- Ranking a test set of real jobs qualitatively resembles the candidate's own ranking.
- Every score has a readable explanation.

### Milestone 5 — Writer + truth verifier

Deliver:

- evidence retrieval for a job
- selected resume/project experiences
- tailored short answers
- resume bullet selection/refinement
- claim extraction from generated writing
- separate claim verification pass
- regeneration/human-review path on verification failure

Exit criteria:

- An unsupported factual claim prevents an application from reaching `READY_FOR_REVIEW`.
- The system can generate a useful, truthful application package from a real job.

### Milestone 6 — Full application dashboard

Deliver:

- application table/filtering
- application detail view
- review queue
- application event timeline
- source + ATS links
- exact material/answer snapshots
- live/near-live agent progress surface

Exit criteria:

- Dashboard can practically replace a job-application spreadsheet.
- Submitted application history is reconstructible.

### Milestone 7 — Handshake browser agent (v1 MVP)

Deliver:

- local Playwright worker
- Handshake form recognition/completion for an initial supported flow
- document selection/upload
- known-answer autofill
- pause on unknown/ambiguous questions
- Remember integration
- dashboard review and explicit final submission approval
- confirmation detection and persistent `SUBMITTED` record

Exit criteria — **v1.0 vertical slice**:

> One genuine internship successfully travels from Handshake ingestion -> analysis -> evidence selection -> verified application package -> dashboard review -> browser completion -> explicit human submission approval -> persistent submitted record with exact materials and links.

Do not expand aggressively into arbitrary ATS support before this works cleanly.

### Milestone 8 — External ATS abstraction

Deliver:

- canonical semantic application form model
- support for at least three meaningfully different ATS workflows (likely common systems such as Workday, Greenhouse, Lever/Ashby; choose based on actual encountered applications)
- confidence-based mapping thresholds
- human fallback for unknown fields
- ATS-specific adapters only where semantic/general automation is insufficient

Exit criteria:

- One candidate/application representation successfully completes flows across at least three ATS families with safe human fallback.

### Milestone 9 — Discovery + batch preparation

Deliver:

- controlled internship discovery/ingestion
- deduplication
- bulk cheap-model analysis
- threshold-based promotion to deeper analysis
- review queue batching
- explicit skip/preference feedback
- sensible rate controls and respect for source access policies

Exit criteria:

- A collection of listings can be reduced autonomously to a high-quality review queue without flooding frontier-model calls.

### Milestone 10 — Outcomes + analytics

Deliver:

- track response/OA/screen/interview/final/offer/rejection/ghosted states
- conversion rates by role type
- conversion by resume variant
- AI cost per application/interview/offer
- preference recommendations based on observed outcomes

Exit criteria:

- Outcome data produces actionable, explainable recommendations without silently changing user preferences.

### Milestone 11 — Portfolio-quality release

Deliver:

- polished README and architecture documentation
- screenshots/demo recording
- fake/sanitized demo candidate and applications
- robust tests
- migration strategy
- browser-agent failure recovery
- structured logging
- privacy/security documentation
- simple local setup

Exit criteria:

- A third party can understand and run the project without access to the real candidate's private data.
- The repository itself is strong enough to use as portfolio evidence.

## 14. Release framing

```text
v0.1 Copilot     M0-M5
  Job -> grounded, verified application package

v1.0 Agent       M6-M7
  Dashboard -> approve -> Handshake application -> tracked submission

v2.0 Pipeline    M8-M11
  Multiple ATSs -> discovery -> batching -> outcomes -> polished release
```

## 15. Immediate next implementation target

Finish Milestone 0 before beginning Milestone 1.

Specifically:

1. Ensure dependencies install and the monorepo builds/types cleanly.
2. Connect the dashboard to `packages/db` rather than displaying only hard-coded data.
3. Add a development/seed path for one fake internship.
4. Render that persisted internship in the dashboard.
5. Add baseline tests/configuration.
6. Only then implement candidate-profile/Remember behavior.

Avoid implementing GitHub, browser automation, external ATS adapters, or autonomous discovery yet. They depend on the domain and persistence foundations being trustworthy.

## 16. Definition of success

The project succeeds when the candidate can supervise a trustworthy agent rather than manually perform repetitive internship-application work. The differentiator is not that an LLM can click Apply. It is the combination of:

- evidence-grounded candidate understanding
- truthful, verified generation
- explainable job matching
- persistent semantic memory
- cost-aware model routing
- deterministic browser automation where possible
- human control over consequential actions
- complete application audit history

Build for those properties first. Scale application volume second.
