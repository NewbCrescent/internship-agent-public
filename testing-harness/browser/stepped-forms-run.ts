/**
 * Several-page forms on sites without an adapter (Track 74), in real Chromium
 * against two fictional, modelled fixtures served on `.example` hosts
 * (testing-harness/browser/fixtures/stepped-phenom-application.html and
 * stepped-paylocity-application.html). Every host resolves to nothing
 * (`--host-resolver-rules=MAP * ~NOTFOUND`), every document is served by
 * `context.route`, and every other request is aborted, so no network is
 * used; the data directory and SQLite database are temporary. The live
 * Phenom and Paylocity steps after step 1 were never captured, so these
 * steps are modelled (fixture: modelled). Proves:
 * (a) a Phenom-shaped form (step=<n> in its address) started by the
 *     candidate is walked from step 1 to its Review step: the Osano banner is
 *     denied, never accepted, the names and email are typed, step 2's age
 *     list takes the fictional saved answer, and the run waits for approval
 *     with its site type unconfirmed; Submit is never clicked;
 * (b) the same form on an automatic run reaches the submit step with no
 *     auto-submit blocker (Track 80); Submit is never clicked;
 * (c) that run, confirmed and approved by the candidate, is walked again and
 *     submitted with exactly one Submit click on the Review step;
 * (d) a Paylocity-shaped form ("Step n of 3", steps drawn in place) pauses on
 *     step 1's County with no Next click; the candidate's one-run answer and a
 *     continue walk it to step 3, with County filled and OneTrust rejected;
 * (e) a field the site marks invalid only after Next (`?invalid=1`) pauses
 *     the run with the site's error; answering it and continuing reaches the
 *     last step;
 * (f) without a step count (`?nocount=1`) the several-page stop stays:
 *     nothing is typed and no run is saved;
 * (g) a step showing both "Next Step" and "Submit" (`?both=1`) stops the run
 *     with a step-transition capture, nothing clicked as submit;
 * (h) a Next Step that shows a confirmation (`?confirm=1`) stops the run and
 *     never marks it submitted;
 * (i) the auto-submit policy approves a fresh automatic Phenom-shaped run
 *     (Track 80), which is walked again and clicked once on Submit, then held
 *     as a possible submission (failed, approval kept, evidence saved, never
 *     marked submitted); the only real-Chromium proof of submitControlLabel.
 *
 * Usage: pnpm test:browser:stepped-forms
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { chromium, type Page } from "playwright-core";

import {
  answerRunPause,
  approveApplication,
  approveRunSubmission,
  approveRunSubmissionAutomatically,
  confirmRunAts,
  continueBrowserRun,
  evaluateAndPersistMatch,
  getBrowserRuns,
  prepareApplication,
  readStopEvidence,
  readSubmitEvidence,
  startBrowserRun,
  submitBrowserRun
} from "@internship-agent/agent";
import { createApplicationPage, SubmissionUnverified } from "@internship-agent/browser";
import {
  createDatabase,
  getJobPosting,
  LOCAL_CANDIDATE_ID,
  listProjectEvidenceProfiles,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveCandidate,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import { autoSubmitBlockers } from "@internship-agent/domain";

const PREFIX = "internship-agent-stepped-forms-";
const PHENOM_HOST = "careers.fixturesteps.example";
const PHENOM_URL = `https://${PHENOM_HOST}/us/en/apply?jobSeqNo=R400004&step=1&stepname=personalInformation`;
const PAY_HOST = "recruiting.fixturepay.example";
const PAY_URL = `https://${PAY_HOST}/Recruiting/Jobs/Apply/1000002`;
const EMAIL = "jordan@example.test";
const COUNTY = "step-1::public-site-address-county";
const LOCATION = "step-2::questions.location";

type PhenomState = { values: Record<string, string>; nextClicks: number; submitClicks: number; acceptClicks: number; denyClicks: number };
type PayState = { step: number; values: Record<string, string>; nextClicks: number; submitClicks: number; acceptClicks: number; rejectClicks: number; done: string | null };

type FactKey = "authorized_to_work" | "requires_sponsorship" | "available_start_date" | "age_18_or_older";

function saveFact(database: DatabaseSync, key: FactKey, scope: { kind: "country"; code: string } | { kind: "global" }, value: boolean | string) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The seeded posting as an external application with fictional evidence, profile, and saved answers; approved unless `automatic`. */
function preparedJob(database: DatabaseSync, automatic: boolean): string {
  seedDevelopmentData(database);
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  saveFact(database, "age_18_or_older", { kind: "global" }, true);
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID, owner: "example", name: "evidence-demo", url: "https://github.com/example/evidence-demo",
    defaultBranch: "main", description: "Fixture evidence.", observedHeadSha: "sha-fixture"
  });
  const sha = "sha-fixture";
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id, name: "evidence-demo", summary: "Fixture project.", fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.", evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme", commitSha: sha, path: "README.md", startLine: 2, endLine: 2,
        sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L2`, excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0]!.claims[0]!;
  if (!reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })) throw new Error("the fixture evidence was not allowed");
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  database.prepare("UPDATE jobs SET application_type = 'EXTERNAL_ATS' WHERE id = ?").run(row.id);
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  prepareApplication(row.id, { database });
  if (!automatic) approveApplication(row.id, { database });
  saveCandidate(database, LOCAL_CANDIDATE_ID, {
    fullName: "Jordan Rivera", email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera", phone: "+1 555 0100", addressCountry: "United States"
  });
  return row.id;
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  let scenarios = 0;
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const phenom = fixture("stepped-phenom-application.html");
    const paylocity = fixture("stepped-paylocity-application.html");
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && request.resourceType() === "document") {
        const body = url.hostname === PHENOM_HOST && url.pathname === "/us/en/apply" ? phenom
          : url.hostname === PAY_HOST && url.pathname === "/Recruiting/Jobs/Apply/1000002" ? paylocity
            : null;
        if (body !== null) {
          await route.fulfill({ status: 200, contentType: "text/html", body });
          return;
        }
      }
      await route.abort();
    });

    // The run closes its page; the kept tab stays open so its fixture state can be read after the run.
    const tabs: Page[] = [];
    const openPage = async (url: string) => {
      const tab = await context.newPage();
      tabs.push(tab);
      await tab.goto(url);
      return { ...createApplicationPage(tab), close: async () => undefined };
    };
    const renderPdf = async (_html: string, outputPath: string) => {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, "%PDF-1.7\n% fixture resume\n%%EOF\n");
      return { pages: 1 };
    };
    const phenomState = (tab: Page | undefined) => tab
      ? tab.evaluate(() => (window as unknown as { fixtureState(): PhenomState }).fixtureState())
      : Promise.resolve(null);
    const payState = (tab: Page | undefined) => tab
      ? tab.evaluate(() => (window as unknown as { fixtureState(): PayState }).fixtureState())
      : Promise.resolve(null);
    const closeTabs = async () => { for (const tab of tabs.splice(0)) await tab.close(); };
    let databases = 0;
    const fresh = (automatic: boolean) => {
      databases += 1;
      const database = createDatabase(join(temp, `db-${databases}.sqlite`));
      return { database, jobId: preparedJob(database, automatic), dataDir: join(temp, `data-${databases}`) };
    };
    const started = (database: DatabaseSync, jobId: string, dataDir: string, url: string, automatic: boolean) => startBrowserRun(jobId, url, {
      database, dataDir, openPage, renderPdf, voiceDrafter: null, pauseReviewer: null, automatic
    });
    const caught = async (work: Promise<unknown>): Promise<Error | null> => {
      try {
        await work;
        return null;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };

    // (a) Phenom-shaped, candidate-started: walked to Review, waiting for approval, nothing submitted.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const report = await started(database, jobId, dataDir, PHENOM_URL, false);
      const tab = tabs.at(-1);
      const state = await phenomState(tab);
      check(report.run.status === "awaiting-approval", `(a) run status ${report.run.status} (pauses ${report.run.pauses.map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
      check(!report.run.atsConfirmed && report.run.atsKind === "unknown", `(a) site type ${report.run.atsKind} confirmed ${report.run.atsConfirmed}`);
      check(tab !== undefined && new URL(tab.url()).searchParams.get("step") === "3", `(a) the walk ended at ${tab?.url()}`);
      check(state !== null && state.denyClicks >= 1 && state.acceptClicks === 0, `(a) banner clicks ${JSON.stringify(state)}`);
      check(state?.values["1:cntryFields.firstName"] === "Jordan" && state.values["1:cntryFields.lastName"] === "Rivera" && state.values["1:email"] === EMAIL,
        `(a) step 1 values ${JSON.stringify(state?.values)}`);
      check(state?.values["2:questions.adult"] === "Yes", `(a) step 2 age answer ${state?.values["2:questions.adult"]}`);
      check(state?.nextClicks === 2 && state.submitClicks === 0, `(a) clicks ${JSON.stringify(state)}`);
      check(report.run.decisions.every((decision) => decision.fieldId.startsWith("step-")), `(a) decision ids ${report.run.decisions.map((decision) => decision.fieldId).join(", ")}`);
      await closeTabs();
      database.close();
    }

    // (b) and (c) Phenom-shaped, automatic: no stepped blocker (Track 80), then submitted after the candidate's approval.
    scenarios += 2;
    {
      const { database, jobId, dataDir } = fresh(true);
      const report = await started(database, jobId, dataDir, PHENOM_URL, true);
      const startState = await phenomState(tabs.at(-1));
      check(report.run.status === "awaiting-approval", `(b) run status ${report.run.status}`);
      check(!autoSubmitBlockers(report.run).some((blocker) => /several pages|recognized/i.test(blocker)), `(b) blockers ${autoSubmitBlockers(report.run).join(" | ")}`);
      check(startState?.submitClicks === 0, `(b) clicks ${JSON.stringify(startState)}`);
      confirmRunAts(report.run.id, "unknown", { database });
      approveRunSubmission(report.run.id, undefined, { database });
      const before = tabs.length;
      const submitted = await submitBrowserRun(report.run.id, {
        database, dataDir, openPage, renderPdf, applicationRecord: null, submitWait: { timeoutMs: 10_000, pollMs: 200 }
      });
      const submitState = await phenomState(tabs.at(-1));
      check(tabs.length === before + 1, `(c) the submit opened ${tabs.length - before} tab(s)`);
      check(submitted.status === "submitted" && (submitted.confirmationText ?? "").includes("Thank you for applying"), `(c) ${submitted.status}: ${submitted.confirmationText}`);
      check(submitState?.submitClicks === 1 && submitState.nextClicks === 2, `(c) clicks ${JSON.stringify(submitState)}`);
      check((await phenomState(tabs[0]))?.submitClicks === 0, "(c) the start tab was submitted");
      await closeTabs();
      database.close();
    }

    // (d) Paylocity-shaped: County pauses step 1; the one-run answer and a continue walk it to step 3.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const report = await started(database, jobId, dataDir, PAY_URL, false);
      const startState = await payState(tabs.at(-1));
      const open = report.run.pauses.filter((pause) => pause.status === "open").map((pause) => pause.fieldId);
      check(report.run.status === "paused-needs-input" && open.length === 1 && open[0] === COUNTY, `(d) start ${report.run.status}, open ${open.join(", ")}`);
      check(startState?.nextClicks === 0 && startState.step === 1, `(d) start clicks ${JSON.stringify(startState)}`);
      check(startState?.rejectClicks !== undefined && startState.rejectClicks >= 1 && startState.acceptClicks === 0, `(d) banner clicks ${JSON.stringify(startState)}`);
      await answerRunPause(report.run.id, COUNTY, "Fixture County", false, { database });
      const continued = await continueBrowserRun(report.run.id, { database, dataDir, openPage, renderPdf, voiceDrafter: null, pauseReviewer: null });
      const state = await payState(tabs.at(-1));
      check(continued.run.status === "awaiting-approval", `(d) continue ${continued.run.status} (pauses ${continued.run.pauses.map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
      check(state?.step === 3 && state.values["1:public-site-address-county"] === "Fixture County" && state.values["1:info.email"] === EMAIL,
        `(d) continue state ${JSON.stringify(state)}`);
      check(state?.submitClicks === 0, `(d) submit clicks ${state?.submitClicks}`);
      await closeTabs();
      database.close();
    }

    // (e) A field the site marks invalid after Next pauses with the site's error; the answer reaches the last step.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const report = await started(database, jobId, dataDir, `${PHENOM_URL}&invalid=1`, false);
      const pause = report.run.pauses.find((entry) => entry.fieldId === LOCATION);
      check(report.run.status === "paused-needs-input" && pause?.status === "open" && pause.question.includes("This field is required."),
        `(e) start ${report.run.status}, pause ${JSON.stringify(pause)}`);
      await answerRunPause(report.run.id, LOCATION, "Fixture City", false, { database });
      const continued = await continueBrowserRun(report.run.id, { database, dataDir, openPage, renderPdf, voiceDrafter: null, pauseReviewer: null });
      const state = await phenomState(tabs.at(-1));
      check(continued.run.status === "awaiting-approval", `(e) continue ${continued.run.status} (pauses ${continued.run.pauses.map((entry) => `${entry.fieldId}: ${entry.question}`).join(" | ")})`);
      check(state?.values["2:questions.location"] === "Fixture City" && state.submitClicks === 0, `(e) state ${JSON.stringify(state)}`);
      await closeTabs();
      database.close();
    }

    // (f) No step count: today's several-page stop, nothing typed, no run saved.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const error = await caught(started(database, jobId, dataDir, `${PAY_URL}?nocount=1`, false));
      const state = await payState(tabs.at(-1));
      check(error?.message.includes(`continues over several pages (its button says "Next Step")`) === true, `(f) stop: ${error?.message ?? "none"}`);
      check(state !== null && Object.keys(state.values).length === 0 && state.nextClicks === 0, `(f) state ${JSON.stringify(state)}`);
      const typed = await tabs.at(-1)?.evaluate(() => Array.from(document.querySelectorAll("input[type=text]")).some((input) => (input as HTMLInputElement).value !== ""));
      check(typed === false, "(f) a box was typed into");
      check(getBrowserRuns(jobId, database).length === 0, "(f) a run was saved");
      await closeTabs();
      database.close();
    }

    // (g) Both "Next Step" and "Submit" on a step: stopped with a step-transition capture, nothing submitted.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const error = await caught(started(database, jobId, dataDir, `${PAY_URL}?both=1&county=0`, false));
      const state = await payState(tabs.at(-1));
      check(error?.message.includes("shows both a submit control") === true, `(g) stop: ${error?.message ?? "none"}`);
      check(readStopEvidence(dataDir, jobId).some((entry) => entry.kind === "step-transition"), `(g) captures ${readStopEvidence(dataDir, jobId).map((entry) => entry.kind).join(", ")}`);
      check(state?.submitClicks === 0 && state.step === 2, `(g) state ${JSON.stringify(state)}`);
      check(getBrowserRuns(jobId, database).length === 0, "(g) a run was saved");
      await closeTabs();
      database.close();
    }

    // (h) A Next Step that shows a confirmation: stopped, never marked submitted.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(false);
      const error = await caught(started(database, jobId, dataDir, `${PAY_URL}?confirm=1&county=0`, false));
      check(error?.message.includes("looks like a confirmation") === true, `(h) stop: ${error?.message ?? "none"}`);
      check(!getBrowserRuns(jobId, database).some((run) => run.status === "submitted"), "(h) a run was marked submitted");
      await closeTabs();
      database.close();
    }

    // (i) Track 80: the auto-submit policy submits a fresh automatic Phenom-shaped run once and holds it as a possible submission.
    scenarios += 1;
    {
      const { database, jobId, dataDir } = fresh(true);
      const report = await started(database, jobId, dataDir, PHENOM_URL, true);
      check(report.run.status === "awaiting-approval", `(i) run status ${report.run.status}`);
      approveRunSubmissionAutomatically(report.run.id, ["fixture"], { database });
      const error = await caught(submitBrowserRun(report.run.id, {
        database, dataDir, openPage, renderPdf, applicationRecord: null, policyApproval: true, submitWait: { timeoutMs: 10_000, pollMs: 200 }
      }));
      const submitState = await phenomState(tabs.at(-1));
      check(error instanceof SubmissionUnverified && error.message.includes("held as a possible submission"), `(i) error: ${error?.message ?? "none"}`);
      check(submitState?.submitClicks === 1 && submitState.nextClicks === 2 && submitState.acceptClicks === 0, `(i) clicks ${JSON.stringify(submitState)}`);
      const after = getBrowserRuns(jobId, database).find((run) => run.id === report.run.id);
      check(after?.status === "failed" && !!after.submissionApprovedAt && after.confirmationText === null, `(i) run ${after?.status}, approved ${after?.submissionApprovedAt}, confirmation ${after?.confirmationText}`);
      check(after?.atsConfirmed === true && after.atsKind === "unknown", `(i) site type ${after?.atsKind} confirmed ${after?.atsConfirmed}`);
      check(getJobPosting(database, jobId)?.status !== "SUBMITTED", `(i) job status ${getJobPosting(database, jobId)?.status}`);
      check(readSubmitEvidence(dataDir, report.run).some((entry) => entry.outcome === "unknown"), `(i) evidence ${readSubmitEvidence(dataDir, report.run).map((entry) => entry.outcome).join(", ")}`);
      await closeTabs();
      database.close();
    }

    await context.close();
  } finally {
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`STEPPED_FORMS_REPORT {"status":"failed","scenarios":${scenarios},"failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`STEPPED_FORMS_REPORT {"status":"passed","scenarios":${scenarios}}`);
}

main().catch((error) => {
  console.error(`STEPPED_FORMS_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
