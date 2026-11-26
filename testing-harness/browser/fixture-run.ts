/**
 * Milestone 7 fixture proof: drives the REAL executor (recognition, planning,
 * filling, submit, confirmation detection) against a local Handshake-style
 * form. No server is needed — the fixture loads over file:// — and no
 * network is touched. The uploaded resume is a fictional structured resume
 * printed to a real PDF, as runs outside Handshake Quick Apply do, and the
 * one-page page count is checked against real Chromium output. Run with tsx,
 * like the seed scripts.
 *
 * Usage: pnpm test:browser:fixture
 * Requires a working Chromium for playwright-core (see agent:doctor).
 */
import { pathToFileURL } from "node:url";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

import {
  applyDecisions,
  captureWorkdayEvidence,
  createPlaywrightPage,
  createWorkdayPage,
  walkWorkdayApplication,
  type WorkdayPage,
  isPdfFile,
  planAutofill,
  recognizeCurrentForm,
  renderHtmlToPdf,
  submitAndConfirm
} from "@internship-agent/browser";
import type { ApplicationHistory, EducationRow, ResumeDocument } from "@internship-agent/domain";
import { renderResumeDocumentHtml } from "@internship-agent/resume";

const FIXTURE_RESUME: ResumeDocument = {
  header: {
    fullName: "Jordan Rivera",
    email: "jordan@example.com",
    phone: null,
    githubUrl: "https://github.com/example",
    linkedinUrl: null,
    portfolioUrl: null
  },
  education: { school: "Example State University", degree: "B.S. Computer Science", gpa: "3.800", graduationDate: "2028-05-15" },
  experience: [{
    entryId: "11111111-1111-4111-8111-111111111111",
    revisionId: "11111111-1111-4111-8111-111111111112",
    title: "Aurora Labs",
    role: "Software Engineering Intern",
    linkLabel: null,
    linkUrl: null,
    location: "Berkeley, CA",
    dateText: "2026",
    bullets: ["Shipped Python services in production."]
  }],
  projects: [],
  skills: [{
    entryId: "22222222-2222-4222-8222-222222222222",
    revisionId: "22222222-2222-4222-8222-222222222223",
    title: "Languages",
    role: null,
    linkLabel: null,
    linkUrl: null,
    location: null,
    dateText: null,
    bullets: ["Python", "TypeScript"]
  }]
};

// tsx runs this file as CommonJS, which has no top-level await.
async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-fixture-"));
  const resumePath = join(directory, "resume.pdf");
  const transcriptPath = join(directory, "transcript.pdf");
  const TRANSCRIPT_ID = "33333333-3333-4333-8333-333333333333";
  const { pages } = await renderHtmlToPdf(renderResumeDocumentHtml(FIXTURE_RESUME), resumePath);
  const overflow = await renderHtmlToPdf(renderResumeDocumentHtml({
    ...FIXTURE_RESUME,
    experience: [{ ...FIXTURE_RESUME.experience[0]!, bullets: Array.from({ length: 90 }, (_, index) => `Fixture bullet ${index + 1}.`) }]
  }), join(directory, "overflow.pdf"));

  const fixtureUrl = pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/handshake-application.html")).href;
  const launched = await chromium.launch();
  const page = await launched.newPage();
  // No page shim here: tsx compiles with keepNames, and the adapter itself must
  // cope with the `__name` helper its evaluated functions reference.
  await page.goto(fixtureUrl);
  const adapted = createPlaywrightPage(page);

  const form = await recognizeCurrentForm(adapted);
  const plan = planAutofill(form, {
    profile: { email: "jordan@example.com" },
    resolutions: new Map([
      ["auth", { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true }]
    ]),
    packageAnswers: [{
      prompt: "Why are you interested in this role?",
      text: "I am excited about this internship."
    }],
    variantId: "11111111-1111-4111-8111-111111111111",
    transcriptDocumentId: TRANSCRIPT_ID
  });

  const failures: string[] = [];
  if (!isPdfFile(resumePath)) failures.push("rendered resume is not a PDF");
  if (pages !== 1) failures.push(`fixture resume printed ${pages} pages, expected 1`);
  if (overflow.pages < 2) failures.push(`overflow resume printed ${overflow.pages} pages, expected at least 2`);
  const byId = new Map(plan.decisions.map((decision) => [decision.fieldId, decision]));
  const expectDecision = (fieldId: string, action: string) => {
    if (byId.get(fieldId)?.action !== action) {
      failures.push(`${fieldId}: expected ${action}, got ${byId.get(fieldId)?.action}`);
    }
  };
  expectDecision("email", "fill");
  expectDecision("auth", "choose");
  expectDecision("agree", "pause");
  expectDecision("resume", "upload");
  expectDecision("transcript", "upload");
  expectDecision("color", "skip");

  // A transcript is a stored candidate PDF; the fixture copies the rendered one.
  await renderHtmlToPdf("<!doctype html><p>Fixture transcript</p>", transcriptPath);
  const { applied } = await applyDecisions(adapted, form, plan.decisions, (decision) => {
    if (decision.action !== "upload") return null;
    return decision.basis?.kind === "candidate_document" ? transcriptPath : resumePath;
  });

  const emailValue = await page.getByLabel("Email address").inputValue();
  if (emailValue !== "jordan@example.com") failures.push(`email not filled: ${emailValue}`);
  const interestValue = await page.getByLabel(/Why do you want/).inputValue();
  if (!interestValue.includes("excited about this internship")) failures.push("interest answer not filled");
  const uploaded = await page.getByLabel("Resume").evaluate((element) => {
    const file = (element as HTMLInputElement).files?.[0];
    return file ? { count: 1, name: file.name, type: file.type } : { count: 0, name: "", type: "" };
  });
  if (uploaded.count !== 1) failures.push("resume not uploaded");
  if (uploaded.name !== "resume.pdf" || uploaded.type !== "application/pdf") {
    failures.push(`resume uploaded as ${uploaded.name} (${uploaded.type || "no type"})`);
  }
  const transcriptName = await page.getByLabel("Unofficial transcript").evaluate((element) =>
    (element as HTMLInputElement).files?.[0]?.name ?? ""
  );
  if (transcriptName !== "transcript.pdf") failures.push(`transcript field received "${transcriptName || "nothing"}"`);

  expectDecision("fullName", "pause");
  // A real run cannot submit with open pauses; stand in for the candidate
  // answering them, as the run lifecycle requires before approval.
  await page.getByLabel("Full name").fill("Jordan Rivera");
  await page.getByLabel("I agree to the terms").check();

  await submitAndConfirm(adapted);
  const doneVisible = await page.getByText("Confirmation #FIXTURE-001").isVisible();
  if (!doneVisible) failures.push("confirmation page not shown");

  // Handshake Quick apply: open the dialog, read only inside it, keep the
  // attached resume, and click only the dialog's own submit.
  const quickPage = await launched.newPage();
  await quickPage.goto(pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/handshake-quick-apply.html")).href);
  const quick = createPlaywrightPage(quickPage);
  // Before the dialog opens, its Submit Application button is hidden and must never be clicked.
  const earlySubmit = await quick.clickSubmit().then(() => "clicked", (error: unknown) => (error instanceof Error ? error.message : String(error)));
  if (earlySubmit === "clicked") failures.push("clicked a submit control while the dialog was hidden");
  if (!(await quick.openApplicationDialog?.())) failures.push("Quick apply dialog did not open");
  const dialogForm = await recognizeCurrentForm(quick);
  if (dialogForm.fields.length !== 0) failures.push(`dialog form read page fields: ${dialogForm.fields.map((field) => field.label).join(", ")}`);
  const attached = await quick.attachedDocumentNames?.() ?? [];
  if (attached.join("|") !== "Jordan Rivera - Resume.pdf") failures.push(`attached names read as ${JSON.stringify(attached)}`);
  const quickConfirmation = await submitAndConfirm(quick).catch((error: unknown) => {
    failures.push(`Quick apply submit: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  });
  const state = await quickPage.evaluate(() => (window as unknown as { fixture: { quickApplyClicks: number; removedAttachment: boolean; submittedVia: string | null; untrustedSubmitClicks?: number } }).fixture);
  if (state.untrustedSubmitClicks) failures.push(`${state.untrustedSubmitClicks} script-dispatched submit clicks`);
  if (state.quickApplyClicks !== 1) failures.push(`Quick apply clicked ${state.quickApplyClicks} times`);
  if (state.removedAttachment) failures.push("the attached resume was removed");
  if (state.submittedVia !== "dialog") failures.push("the dialog's Submit Application was not clicked");
  if (!quickConfirmation.includes("Applied on January 7, 2026")) failures.push("Quick apply confirmation not read");

  // A client-rendered form (like Ashby) draws its fields after load; the
  // adapter must wait for them, then trim the oversized label and keep the
  // number field typed as a number.
  const delayedPage = await launched.newPage();
  await delayedPage.goto(pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/delayed-form.html")).href);
  const delayed = await recognizeCurrentForm(createPlaywrightPage(delayedPage));
  if (delayed.fields.length !== 3) failures.push(`delayed form: expected 3 fields, got ${delayed.fields.length}`);
  if (delayed.fields.find((field) => field.id === "grad-year")?.kind !== "number") failures.push("delayed form: graduation year is not a number field");
  const story = delayed.fields.find((field) => field.id === "story");
  if (!story || story.label.length !== 300 || !story.label.endsWith("…")) failures.push("delayed form: long label was not trimmed to 300 characters");

  // A Workday-style multi-step application: the real Workday adapter and step
  // walker fill from the profile, pause on what only the candidate can answer
  // (including a sensitive question), stop at Review, and submit only in
  // submit mode.
  const workdayUrl = pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/workday-application.html")).href;
  const workdayTab = await launched.newPage();
  await workdayTab.goto(workdayUrl);
  const workday = createWorkdayPage(workdayTab);
  if (await workday.enterApplication() !== "flow") failures.push("workday: the application flow did not open");
  const contact = { legalFirstName: "Jordan", legalLastName: "Rivera", addressCity: "Seattle", addressRegion: "Washington", addressCountry: "United States of America", phoneType: "Mobile" };
  const candidateAnswers = new Map<string, string>();
  // A 2029 resume and a transcript, as a transcript application uses.
  const resume2029Path = join(directory, "resume-graduating-2029.pdf");
  copyFileSync(resumePath, resume2029Path);
  const history = (endYear: number): ApplicationHistory => ({
    work: [
      { entryId: "33333333-3333-4333-8333-333333333333", company: "Northwind Tutoring", title: "Programming Tutor", location: "Berkeley, CA",
        start: { year: 2026, month: 2 }, end: { year: 2026, month: 5 }, current: false, description: "Taught Python to middle schoolers." },
      { entryId: "44444444-4444-4444-8444-444444444444", company: "Contoso Identity", title: "Document Verification Intern", location: "Remote",
        start: { year: 2026, month: 6 }, end: { year: 2026, month: 8 }, current: false, description: "Built verification tooling." }
    ],
    education: [
      { key: "college", school: "UC Berkeley", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: "Computer Science", gpa: "3.8", startYear: 2025, endYear },
      { key: "high_school", school: "Northwind High School", level: "high_school", degree: null, fieldOfStudy: null, gpa: null, startYear: 2021, endYear: 2025 }
    ]
  });
  const historyOptions = { standard: history(2028), transcript: history(2029), answers: new Map<string, string>() };
  // Two colleges and the high school: Workday's Education section gets the two colleges only (the candidate's rule,
  // 2026-11-26), so the scenarios that need a second row use a second college.
  const secondCollege = (): EducationRow => ({
    key: "college", school: "University of California, Los Angeles", level: "bachelor", degree: "B.S. Computer Science",
    fieldOfStudy: "Computer Engineering", gpa: null, startYear: 2023, endYear: 2025
  });
  const twoColleges = (endYear: number): ApplicationHistory => {
    const base = history(endYear);
    return { ...base, education: [base.education[0]!, secondCollege(), base.education[1]!] };
  };
  const twoCollegeOptions = { standard: twoColleges(2028), transcript: twoColleges(2029), answers: new Map<string, string>() };
  const highSchoolRows = (rows: Array<Record<string, string>>) => rows.filter((row) => /high school/i.test(row.school ?? ""));
  const planWorkday = async (_step: unknown, workdayForm: Parameters<typeof planAutofill>[0], state?: { transcript: boolean }) => {
    const planned = planAutofill(workdayForm, {
      profile: contact, resolutions: new Map(), packageAnswers: [], variantId: "11111111-1111-4111-8111-111111111111",
      transcriptDocumentId: state?.transcript ? "22222222-2222-4222-8222-222222222222" : null
    });
    const decisions = planned.decisions.map((decision) => {
      const answer = candidateAnswers.get(decision.fieldId);
      const field = workdayForm.fields.find((entry) => entry.id === decision.fieldId);
      if (decision.action !== "pause" || !answer || !field) return decision;
      if (field.kind === "checkbox") return { ...decision, action: "check" as const, value: "true", pause: null };
      if (field.kind === "select" || field.kind === "radio") return { ...decision, action: "choose" as const, value: answer, pause: null };
      return { ...decision, action: "fill" as const, value: answer, pause: null };
    });
    return {
      decisions,
      pauses: planned.pauses.filter((pause) => !candidateAnswers.has(pause.fieldId)),
      safeguardHalt: planned.safeguardHalt,
      uploadPathFor: (decision: { action: string; basis: { kind: string } | null }) => {
        if (decision.action !== "upload") return null;
        if (decision.basis?.kind === "candidate_document") return transcriptPath;
        return state?.transcript ? resume2029Path : resumePath;
      }
    };
  };
  const firstWalk = await walkWorkdayApplication(workday, planWorkday, { mode: "fill", history: historyOptions });
  if (firstWalk.outcome !== "paused" || firstWalk.steps.at(-1)?.name !== "My Information") failures.push(`workday: expected a pause on My Information, got ${firstWalk.outcome}`);
  if (firstWalk.pauses.map((pause) => pause.fieldId).join() !== "My Information::formField-candidateIsPreviousWorker") failures.push(`workday: unexpected pauses ${firstWalk.pauses.map((pause) => pause.fieldId).join()}`);
  if (!firstWalk.fieldLabels["My Information::formField-candidateIsPreviousWorker"]) failures.push("workday: field labels were not recorded for the record");
  if (await workdayTab.inputValue("#formField-legalName--firstName-input") !== "Jordan") failures.push("workday: first name not filled from the profile");
  if ((await workdayTab.innerText("[data-listbox=formField-countryRegion]")).trim() !== "Washington") failures.push("workday: state not chosen from the listbox");
  if ((await workdayTab.innerText("[data-listbox=formField-country]")).trim() !== "United States of America") failures.push("workday: preselected country was not kept");
  if ((await workdayTab.innerText("[data-listbox=formField-phoneType]")).trim() !== "Mobile") failures.push("workday: phone type not chosen from the profile");
  const heardFrom = await workdayTab.evaluate(() => (window as unknown as { fixture: { values: Record<string, string> } }).fixture.values["formField-source"]);
  if (heardFrom !== "LinkedIn") failures.push(`workday: "How did you hear" should pick LinkedIn, got ${heardFrom}`);
  candidateAnswers.set("formField-candidateIsPreviousWorker", "No");
  candidateAnswers.set("formField-whyUs", "Fixture Aerospace builds the flight software I want to work on.");
  candidateAnswers.set("formField-gradYear", "2028");
  candidateAnswers.set("formField-gender", "Decline to self-identify");
  candidateAnswers.set("formField-agreement", "yes");
  const secondWalk = await walkWorkdayApplication(workday, planWorkday, { mode: "fill", history: historyOptions });
  if (secondWalk.outcome !== "review") failures.push(`workday: expected to stop at Review, got ${secondWalk.outcome} (${secondWalk.errors.join(" ")} ${secondWalk.pauses.map((pause) => pause.question).join(" ")})`);
  type FixtureState = {
    step: number; resumes: string[]; transcript: string | null; submitted: boolean;
    work: Array<Record<string, string | boolean>>; education: Array<Record<string, string>>; websites?: number;
  };
  const fixtureState = (tab: typeof workdayTab) => tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);
  const workdayState = await fixtureState(workdayTab);
  if (workdayState.resumes.join() !== "resume.pdf") failures.push(`workday: expected one resume on My Experience, got ${workdayState.resumes.join()}`);
  if (workdayState.submitted) failures.push("workday: submitted during a fill walk");
  const [tutor, intern] = workdayState.work;
  if (workdayState.work.length !== 2 || tutor?.company !== "Northwind Tutoring" || tutor.title !== "Programming Tutor" || tutor.fromM !== "02" || tutor.fromY !== "2026" ||
    tutor.toM !== "05" || tutor.toY !== "2026" || tutor.description !== "Taught Python to middle schoolers." || intern?.location !== "Remote" || intern.toM !== "08") {
    failures.push(`workday: work history not entered as recorded: ${JSON.stringify(workdayState.work)}`);
  }
  const [college] = workdayState.education;
  // The candidate's rule (2026-11-26): Workday's Education section gets the college only, never the high school.
  if (workdayState.education.length !== 1 || college?.school !== "University of California, Berkeley" || college.degree !== "Bachelor of Arts (BA)" ||
    college.field !== "Computer Science" || college.gpa !== "3.8" || college.fromY !== "2025" || college.toY !== "2028" ||
    highSchoolRows(workdayState.education).length) {
    failures.push(`workday: education not entered as recorded (the college only, and a B.A. must never become a B.S.): ${JSON.stringify(workdayState.education)}`);
  }
  const confirmWorkday = async (page: WorkdayPage) => {
    for (let attempt = 0; attempt < 20 && !(await page.bodyText()).includes("Application Submitted"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    return page.bodyText();
  };
  const submitWalk = await walkWorkdayApplication(workday, planWorkday, { mode: "submit", confirm: confirmWorkday });
  if (submitWalk.outcome !== "submitted" || !submitWalk.confirmation?.includes("Application Submitted")) failures.push("workday: submit mode did not submit on Review");

  // Synthetic, modeled on the 2026-11-25 real pauses (no form-step DOM was captured): a "Home Mobile" phone
  // type (xboxgaming.wd1), the resume upload in an empty-suffix formField container labelled "Upload a file
  // (5MB max)" (littelfuse.wd1, zoll.wd5), and a start date drawn as Month, Day and Year sections (neogen.wd5).
  const gapsTab = await launched.newPage();
  await gapsTab.goto(`${workdayUrl}?gaps=1`);
  const gapsWorkday = createWorkdayPage(gapsTab);
  await gapsWorkday.enterApplication();
  candidateAnswers.set("formField-earliestStart", "2027-06-01");
  const gapsWalk = await walkWorkdayApplication(gapsWorkday, planWorkday, { mode: "fill", history: historyOptions });
  if (gapsWalk.outcome !== "review") {
    failures.push(`workday gaps: expected to stop at Review, got ${gapsWalk.outcome} (${gapsWalk.errors.join(" ")} ${gapsWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  const gapsState = await gapsTab.evaluate(() => (window as unknown as { fixture: FixtureState & { values: Record<string, string> } }).fixture);
  if (gapsState.values["formField-phoneType"] !== "Home Mobile") failures.push(`workday gaps: phone type should be Home Mobile, got ${gapsState.values["formField-phoneType"]}`);
  if (gapsState.resumes.join() !== "resume.pdf") failures.push(`workday gaps: expected the resume on My Experience's "Upload a file" input, got ${gapsState.resumes.join()}`);
  if (gapsState.values["formField-earliestStart"] !== "06/01/2027") failures.push(`workday gaps: the start date should read 06/01/2027 (month, day, year), got ${gapsState.values["formField-earliestStart"]}`);
  if (gapsState.values["formField-candidateIsPreviousWorker"] !== "No") failures.push(`workday gaps: the previous-worker radio labelled by the question (aria-labelledby) should be answered No, got ${gapsState.values["formField-candidateIsPreviousWorker"]}`);

  // Synthetic, modeled on the 2026-11-25 evidence of neogen.wd5, itw.wd5, littelfuse.wd1, Activision and zoll.wd5:
  // the resume shows "<file> loading" for 2.5 s, then "<file> successfully uploaded", and Save and Continue moves
  // after 1 s with that status still on screen. The walk waits for the upload and never reads its status as an error.
  const uploadTab = await launched.newPage();
  await uploadTab.goto(`${workdayUrl}?gaps=1&upload=slow`);
  const uploadWorkday = createWorkdayPage(uploadTab);
  await uploadWorkday.enterApplication();
  const uploadWalk = await walkWorkdayApplication(uploadWorkday, planWorkday, { mode: "fill", history: historyOptions });
  if (uploadWalk.outcome !== "review") {
    failures.push(`workday slow upload: expected to stop at Review, got ${uploadWalk.outcome} (${uploadWalk.errors.join(" ")} ${uploadWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  const uploadState = await fixtureState(uploadTab);
  if (uploadState.resumes.join() !== "resume.pdf") failures.push(`workday slow upload: expected the resume attached once, got ${JSON.stringify(uploadState.resumes)}`);
  const statusPauses = uploadWalk.pauses.filter((pause) => /loading|successfully uploaded/i.test(`${pause.label} ${pause.question}`));
  if (statusPauses.length) failures.push(`workday slow upload: the upload status became a question: ${statusPauses.map((pause) => pause.label).join(" | ")}`);

  // The same widget refusing the file ("Your document can't be uploaded."): the run pauses on the upload with
  // Workday's words and never saves My Experience.
  const refusedTab = await launched.newPage();
  await refusedTab.goto(`${workdayUrl}?gaps=1&upload=fail`);
  const refusedWorkday = createWorkdayPage(refusedTab);
  await refusedWorkday.enterApplication();
  const refusedWalk = await walkWorkdayApplication(refusedWorkday, planWorkday, { mode: "fill", history: historyOptions });
  const refusedPause = refusedWalk.pauses.find((pause) => pause.status === "open" && pause.fieldId === "My Experience::formField-");
  if (refusedWalk.outcome !== "paused" || refusedWalk.steps.at(-1)?.name !== "My Experience" || !refusedPause?.question.includes("can't be uploaded")) {
    failures.push(`workday refused upload: expected a pause on My Experience's upload with Workday's words, got ${refusedWalk.outcome} (${refusedWalk.errors.join(" ")} ${refusedWalk.pauses
      .map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  if (refusedWalk.pauses.some((pause) => pause.label.includes("loading"))) failures.push("workday refused upload: the loading status became a question");
  if ((await fixtureState(refusedTab)).step !== 1) failures.push("workday refused upload: My Experience was saved past a refused upload");

  // A resume-parsed row that is not the candidate's is deleted; a transcript
  // on a later step sends the run back to backfill Berkeley's end year and the
  // resume with 2029, and walking the same step again adds no duplicate rows.
  const transcriptTab = await launched.newPage();
  await transcriptTab.goto(`${workdayUrl}?parsed=1&transcript=1`);
  const transcriptWorkday = createWorkdayPage(transcriptTab);
  await transcriptWorkday.enterApplication();
  const transcriptWalk = await walkWorkdayApplication(transcriptWorkday, planWorkday, { mode: "fill", history: historyOptions });
  const backfilled = await fixtureState(transcriptTab);
  if (transcriptWalk.outcome !== "review" || !transcriptWalk.transcript) {
    failures.push(`workday transcript: expected Review on the 2029 profile, got ${transcriptWalk.outcome} (${transcriptWalk.errors.join(" ")} ${transcriptWalk.pauses.map((pause) => pause.question).join(" ")})`);
  }
  if (backfilled.work.some((row) => row.company === "Resume Parse Corp") ||
    !transcriptWalk.decisions.some((decision) => decision.action === "remove" && decision.value === "Resume Parse Corp")) {
    failures.push("workday transcript: the parsed row that is not the candidate's was not deleted and recorded");
  }
  if (backfilled.work.length !== 2 || backfilled.education.length !== 1) failures.push(`workday transcript: rows duplicated on the second pass: ${backfilled.work.length} work, ${backfilled.education.length} education`);
  if (backfilled.education[0]?.toY !== "2029") failures.push(`workday transcript: Berkeley's end year was not backfilled to 2029 (${backfilled.education[0]?.toY})`);
  if (backfilled.resumes.join() !== "resume-graduating-2029.pdf") failures.push(`workday transcript: the resume was not replaced by the 2029 print (${backfilled.resumes.join()})`);
  if (backfilled.transcript !== "transcript.pdf") failures.push("workday transcript: the transcript was not uploaded");
  if (new Set(transcriptWalk.decisions.map((decision) => decision.fieldId)).size !== transcriptWalk.decisions.length) failures.push("workday transcript: the backfill left duplicate decision records");

  // Synthetic (the cause was not seen on a live page): My Information is drawn with its
  // fields hidden for 2.5 s. The readiness wait counts only visible fields, so the walk
  // reads and fills First Name instead of saving an empty step.
  const hiddenTab = await launched.newPage();
  await hiddenTab.goto(`${workdayUrl}?hidden=2500`);
  const hiddenWorkday = createWorkdayPage(hiddenTab);
  await hiddenWorkday.enterApplication();
  const hiddenWalk = await walkWorkdayApplication(hiddenWorkday, planWorkday, { mode: "fill" });
  if (!hiddenWalk.fieldLabels["My Information::formField-legalName--firstName"] || hiddenWalk.errors.some((error) => error.includes("First Name is required"))) {
    failures.push(`workday hidden: My Information was not read once its fields showed (${hiddenWalk.outcome}: ${hiddenWalk.errors.join(" ")})`);
  }
  const hiddenFirstName = hiddenWalk.decisions.find((decision) => decision.fieldId === "My Information::formField-legalName--firstName");
  if (hiddenFirstName?.action !== "fill" || hiddenFirstName.value !== "Jordan") failures.push("workday hidden: first name not filled once the fields showed");

  // Synthetic, modeled on the 2026-11-25 real runs on rockwellautomation.wd1, highmarkhealth.wd1
  // and micron.wd1 and the Sierra Space / ZOLL / Neogen / Aerospace stops: lists open in portals a
  // moment after the click, a closed list lingers, picked chips carry option roles, the "How did you
  // hear" tree loads slowly, and each date section's display covers its input. The walk still
  // reads only the list each button opened, picks the hear-about option, and types the dates.
  const realTab = await launched.newPage();
  realTab.setDefaultTimeout(10_000);
  await realTab.goto(`${workdayUrl}?widgets=real`);
  const realWorkday = createWorkdayPage(realTab);
  await realWorkday.enterApplication();
  const realWalk = await walkWorkdayApplication(realWorkday, planWorkday, { mode: "fill", history: twoCollegeOptions })
    .catch((error: unknown) => {
      failures.push(`workday real widgets: the walk threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    });
  if (realWalk && realWalk.outcome !== "review") {
    failures.push(`workday real widgets: expected to stop at Review, got ${realWalk.outcome} (${realWalk.errors.join(" ")} ${realWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  const realState = await realTab.evaluate(() => (window as unknown as { fixture: FixtureState & { values: Record<string, string> } }).fixture);
  if (realState.values["formField-phoneType"] !== "Mobile") failures.push(`workday real widgets: Phone Device Type is ${JSON.stringify(realState.values["formField-phoneType"])}, not Mobile`);
  if (realState.values["formField-source"] !== "LinkedIn") failures.push(`workday real widgets: "How did you hear" is ${JSON.stringify(realState.values["formField-source"])}, not LinkedIn`);
  if (realState.values["formField-countryRegion"] !== "Washington") failures.push(`workday real widgets: State is ${JSON.stringify(realState.values["formField-countryRegion"])}, not Washington`);
  const [realTutor] = realState.work;
  if (realState.work.length !== 2 || realTutor?.fromM !== "02" || realTutor.fromY !== "2026" || realTutor.toM !== "05" || realTutor.toY !== "2026") {
    failures.push(`workday real widgets: work dates were not typed behind their displays: ${JSON.stringify(realState.work)}`);
  }
  if (realState.education[0]?.toY !== "2028") failures.push(`workday real widgets: Berkeley's end year is ${JSON.stringify(realState.education[0]?.toY)}, not 2028`);
  // The Field of Study list left open after its pick must not cover Add Another (the second college's row); the
  // high school is not entered (a GED listed first is never a diploma: the domain chooseDegreeOption tests).
  if (realState.education.length !== 2 || realState.education[0]?.field !== "Computer Science" || realState.education[1]?.degree !== "Bachelor of Science (BS)" ||
    highSchoolRows(realState.education).length) {
    failures.push(`workday real widgets: education rows not entered as recorded: ${JSON.stringify(realState.education)}`);
  }

  // Synthetic, modeled on the Activision / xboxgaming.wd1 evidence (2026-11-25): every row's Field of Study is
  // required, and nothing saved states the second school's field of study. The walk asks that row's question
  // before saving the step, and the answer is used on the next continue.
  const noField = (endYear: number): ApplicationHistory => {
    const base = twoColleges(endYear);
    return { ...base, education: base.education.map((row) => (row.school === secondCollege().school ? { ...row, fieldOfStudy: null } : row)) };
  };
  const fosFieldId = `My Experience::history:education:${secondCollege().school}:field`;
  const fosHistory = { standard: noField(2028), transcript: noField(2029), answers: new Map<string, string>() };
  const fosTab = await launched.newPage();
  await fosTab.goto(`${workdayUrl}?fos=required`);
  const fosWorkday = createWorkdayPage(fosTab);
  await fosWorkday.enterApplication();
  const fosWalk = await walkWorkdayApplication(fosWorkday, planWorkday, { mode: "fill", history: fosHistory });
  if (fosWalk.outcome !== "paused" || !fosWalk.pauses.some((pause) => pause.status === "open" && pause.fieldId === fosFieldId)) {
    failures.push(`workday required field of study: expected the second school's question, got ${fosWalk.outcome} (${fosWalk.errors.join(" ")} ${fosWalk.pauses
      .map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  if (fosWalk.pauses.some((pause) => pause.fieldId.includes("workday-error"))) failures.push("workday required field of study: the step was saved and Workday's error came back");
  if ((await fixtureState(fosTab)).step !== 1) failures.push("workday required field of study: My Experience was saved with the field open");
  fosHistory.answers.set(fosFieldId, "Economics");
  const fosAnswered = await walkWorkdayApplication(fosWorkday, planWorkday, { mode: "fill", history: fosHistory });
  const fosState = await fixtureState(fosTab);
  if (fosAnswered.outcome !== "review" || fosState.education[1]?.field !== "Economics" || fosState.education[0]?.field !== "Computer Science") {
    failures.push(`workday required field of study: the answer was not used on continue: ${fosAnswered.outcome} ${JSON.stringify(fosState.education)} (${fosAnswered.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }

  // Synthetic (rockwellautomation.wd1's run <run id> found neither education date by label; its markup was not
  // captured): dates labelled "Attended From" / "Attended Until" are found by Workday's container ids.
  const idsTab = await launched.newPage();
  await idsTab.goto(`${workdayUrl}?edudates=ids`);
  const idsWorkday = createWorkdayPage(idsTab);
  await idsWorkday.enterApplication();
  const idsWalk = await walkWorkdayApplication(idsWorkday, planWorkday, { mode: "fill", history: twoCollegeOptions });
  const idsState = await fixtureState(idsTab);
  if (idsWalk.outcome !== "review" || idsState.education[0]?.fromY !== "2025" || idsState.education[0]?.toY !== "2028" ||
    idsState.education[1]?.fromY !== "2023" || idsState.education[1]?.toY !== "2025") {
    failures.push(`workday education date ids: dates not found by container id: ${idsWalk.outcome} ${JSON.stringify(idsState.education)} (${idsWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }

  // An education row with no date fields at all asks nothing about them.
  const noDatesTab = await launched.newPage();
  await noDatesTab.goto(`${workdayUrl}?edudates=none`);
  const noDatesWorkday = createWorkdayPage(noDatesTab);
  await noDatesWorkday.enterApplication();
  const noDatesWalk = await walkWorkdayApplication(noDatesWorkday, planWorkday, { mode: "fill", history: historyOptions });
  const datePauses = noDatesWalk.pauses.filter((pause) => /:(?:to|from)$/.test(pause.fieldId));
  if (noDatesWalk.outcome !== "review" || datePauses.length) {
    failures.push(`workday no education dates: expected Review with no date question, got ${noDatesWalk.outcome} (${datePauses.map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }

  // Synthetic, modeled on rockwellautomation.wd1 (schools typed as plain text) and the Rockwell/enGen Degree
  // timeouts: the typed school's suggestion layer covers Degree until the box loses focus. The covered Degree
  // is focused and opened with Enter after 5 s, never force-clicked.
  const coveredTab = await launched.newPage();
  coveredTab.setDefaultTimeout(10_000);
  await coveredTab.goto(`${workdayUrl}?widgets=real&school=text`);
  const coveredWorkday = createWorkdayPage(coveredTab);
  await coveredWorkday.enterApplication();
  const coveredWalk = await walkWorkdayApplication(coveredWorkday, planWorkday, { mode: "fill", history: twoCollegeOptions })
    .catch((error: unknown) => {
      failures.push(`workday covered degree: the walk threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    });
  if (coveredWalk && coveredWalk.outcome !== "review") {
    failures.push(`workday covered degree: expected to stop at Review, got ${coveredWalk.outcome} (${coveredWalk.errors.join(" ")} ${coveredWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }
  const coveredState = await fixtureState(coveredTab);
  if (coveredState.education.length !== 2 || coveredState.education[0]?.degree !== "Bachelor of Arts (BA)" || coveredState.education[1]?.degree !== "Bachelor of Science (BS)") {
    failures.push(`workday covered degree: degrees not chosen: ${JSON.stringify(coveredState.education)}`);
  }

  const openPauses = (walk: Awaited<ReturnType<typeof walkWorkdayApplication>>) => walk.pauses
    .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ");
  const threw = (name: string) => (error: unknown) => {
    failures.push(`workday ${name}: the walk threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return null;
  };

  // Synthetic, modeled on littelfuse.wd1 run <run id> (2026-11-25; no DOM was captured): after My Experience is
  // saved, the progress bar moves on at once while its hidden fields, the resume input with them, stay in the DOM
  // for 2.5 s. That hidden input is neither counted as the next step being ready nor read as a "Resume/CV" field.
  const lingerTab = await launched.newPage();
  await lingerTab.goto(`${workdayUrl}?gaps=1&linger=2500`);
  const lingerWorkday = createWorkdayPage(lingerTab);
  await lingerWorkday.enterApplication();
  const lingerWalk = await walkWorkdayApplication(lingerWorkday, planWorkday, { mode: "fill", history: historyOptions }).catch(threw("lingering step"));
  if (lingerWalk) {
    const lingerState = await fixtureState(lingerTab);
    const hiddenUpload = [...lingerWalk.decisions, ...lingerWalk.pauses].filter((entry) => entry.fieldId.startsWith("Application Questions::file-upload-input-ref"));
    if (lingerWalk.outcome !== "review" || lingerState.resumes.join() !== "resume.pdf" || hiddenUpload.length ||
      !lingerWalk.decisions.some((decision) => decision.fieldId === "Application Questions::formField-whyUs")) {
      failures.push(`workday lingering step: expected Review with one resume and Application Questions read, got ${lingerWalk.outcome} (resumes ${JSON.stringify(lingerState.resumes)}; ${hiddenUpload.length} hidden-upload records; ${lingerWalk.errors.join(" ")} ${openPauses(lingerWalk)})`);
    }
  }

  // Synthetic, modeled on the zoll.wd5 failure of 2026-11-25 13:55Z ("locator.focus: Timeout 30000ms exceeded" on
  // education row 1's Degree; the re-draw trigger was not captured): Escape on My Experience re-draws every row,
  // dropping the run's section tags. Each row field re-tags first, so the run is never stopped by a vanished row.
  const remountTab = await launched.newPage();
  await remountTab.goto(`${workdayUrl}?school=text&remount=1`);
  const remountWorkday = createWorkdayPage(remountTab);
  await remountWorkday.enterApplication();
  const remountWalk = await walkWorkdayApplication(remountWorkday, planWorkday, { mode: "fill", history: twoCollegeOptions }).catch(threw("re-drawn education row"));
  if (remountWalk) {
    const remountState = await fixtureState(remountTab);
    const [remountCollege, remountSecond] = remountState.education;
    const typed = twoColleges(2028).education;
    if (remountWalk.outcome !== "review" || remountState.education.length !== 2 || remountCollege?.degree !== "Bachelor of Arts (BA)" || remountSecond?.degree !== "Bachelor of Science (BS)" ||
      remountCollege.school !== typed[0]!.school || remountSecond.school !== typed[1]!.school) {
      failures.push(`workday re-drawn education row: expected Review with both rows entered, got ${remountWalk.outcome} ${JSON.stringify(remountState.education)} (${remountWalk.errors.join(" ")} ${openPauses(remountWalk)})`);
    }
  }

  // Synthetic, modeled on the public description of Workday's My Experience markup and on employer-e.wd5 run
  // <run id> (every history row "was not added" and no other field of the step was read; no DOM was captured):
  // sections are role="group" labelled "<Name>-section", Adds are add-button with hidden section text, and a
  // Websites section with a plain "Add" follows. Each section is found by its own label, and Websites is never used.
  const ariaTab = await launched.newPage();
  await ariaTab.goto(`${workdayUrl}?sections=aria`);
  const ariaWorkday = createWorkdayPage(ariaTab);
  await ariaWorkday.enterApplication();
  const ariaWalk = await walkWorkdayApplication(ariaWorkday, planWorkday, { mode: "fill", history: historyOptions }).catch(threw("aria sections"));
  if (ariaWalk) {
    const ariaState = await fixtureState(ariaTab);
    const [ariaTutor, ariaIntern] = ariaState.work;
    const [ariaCollege] = ariaState.education;
    const rowPauses = ariaWalk.pauses.filter((pause) => pause.fieldId.endsWith(":row"));
    if (ariaWalk.outcome !== "review" || rowPauses.length || ariaState.websites !== 0 ||
      ariaState.work.length !== 2 || ariaTutor?.company !== "Northwind Tutoring" || ariaTutor.title !== "Programming Tutor" || ariaIntern?.company !== "Contoso Identity" ||
      ariaState.education.length !== 1 || ariaCollege?.school !== "University of California, Berkeley" || ariaCollege.degree !== "Bachelor of Arts (BA)" ||
      highSchoolRows(ariaState.education).length) {
      failures.push(`workday aria sections: expected Review with both sections entered (the college only) and no website row, got ${ariaWalk.outcome} (websites ${ariaState.websites}; work ${JSON.stringify(ariaState.work.map((row) => row.company))}; education ${JSON.stringify(ariaState.education.map((row) => [row.school, row.degree]))}; ${ariaWalk.errors.join(" ")} ${openPauses(ariaWalk)})`);
    }
  }

  // Synthetic copy of the lists micron.wd1 offered on 2026-11-25 (run <run id>): a B.A. takes the one general
  // "Bachelor's Level Degree", and "Computer Science" the one field differing only by a plural ending.
  const micronTab = await launched.newPage();
  await micronTab.goto(`${workdayUrl}?lists=micron`);
  const micronWorkday = createWorkdayPage(micronTab);
  await micronWorkday.enterApplication();
  const micronWalk = await walkWorkdayApplication(micronWorkday, planWorkday, { mode: "fill", history: historyOptions });
  const micronState = await fixtureState(micronTab);
  if (micronWalk.outcome !== "review" || micronState.education[0]?.degree !== "Bachelor's Level Degree" || micronState.education[0]?.field !== "Computer sciences") {
    failures.push(`workday Micron lists: expected Review with "Bachelor's Level Degree" and "Computer sciences", got ${micronWalk.outcome} ${JSON.stringify(micronState.education)} (${micronWalk.pauses
      .filter((pause) => pause.status === "open").map((pause) => `${pause.fieldId}: ${pause.question}`).join(" | ")})`);
  }

  const blockedTab = await launched.newPage();
  await blockedTab.goto(workdayUrl);
  const blockedWorkday = createWorkdayPage(blockedTab);
  await blockedWorkday.enterApplication();
  const blocked = await walkWorkdayApplication(blockedWorkday, async () => ({ decisions: [], pauses: [], safeguardHalt: false }), { mode: "fill" });
  if (blocked.outcome !== "blocked" || !blocked.errors.some((error) => error.includes("First Name is required"))) failures.push("workday: validation errors were not reported");
  // Each Workday error is its own pause, "<field label>: <Workday's text>", on the field's own
  // id; the banner repeating the inline errors adds none.
  const missingIds = await blockedTab.$$eval("[data-fixture-error]", (nodes) =>
    nodes.map((node) => node.closest('[data-automation-id^="formField-"]')?.getAttribute("data-automation-id") ?? ""));
  const errorPauses = blocked.pauses.filter((pause) => pause.status === "open" && pause.fieldId.startsWith("My Information::workday-error"));
  const expectedIds = [...new Set(missingIds)].map((id) => `My Information::workday-error::${id}`).sort();
  if (missingIds.length < 5 || errorPauses.map((pause) => pause.fieldId).sort().join() !== expectedIds.join() || blocked.pauses.length !== expectedIds.length) {
    failures.push(`workday: expected one pause per missing field (${expectedIds.join()}), got ${blocked.pauses.map((pause) => pause.fieldId).join()}`);
  }
  const firstNamePause = blocked.pauses.find((pause) => pause.fieldId === "My Information::workday-error::formField-legalName--firstName");
  if (firstNamePause?.label !== "First Name: The field First Name is required and must have a value.") failures.push(`workday: the First Name error pause reads "${firstNamePause?.label}"`);
  const blockedEvidence = await captureWorkdayEvidence(blockedWorkday, "workday-errors", { detail: "x", errors: blocked.workdayErrors });
  if (!blockedEvidence.invalidFields.some((field) => field.ref === "formField-legalName--firstName" && field.label === "First Name")) {
    failures.push(`workday: the evidence does not list First Name's error (${JSON.stringify(blockedEvidence.invalidFields)})`);
  }
  if (blockedEvidence.outcome !== "workday-errors" || blockedEvidence.detail !== "x" || !blockedEvidence.alertText.includes("First Name")) {
    failures.push("workday: the evidence does not carry the outcome, the detail, and the banner text");
  }

  const signInTab = await launched.newPage();
  await signInTab.goto(`${workdayUrl}?signin=1`);
  if (await createWorkdayPage(signInTab).enterApplication() !== "sign-in") failures.push("workday: the sign-in wall was not detected");

  // Workday's job page (Track 28, markers seen live 2026-11-25): Apply through the chooser,
  // Workday's closed-posting page, an unrelated error box, and Workday's security check.
  const entryUrl = pathToFileURL(join(process.cwd(), "testing-harness/browser/fixtures/workday-entry.html")).href;
  for (const [mode, expected] of [["open", "flow"], ["closed", "closed"], ["other-error", "flow"], ["security", "challenge"], ["security-page", "challenge"]] as const) {
    const tab = await launched.newPage();
    await tab.goto(`${entryUrl}?entry=${mode}`);
    const entered = await createWorkdayPage(tab).enterApplication();
    if (entered !== expected) failures.push(`workday entry (${mode}): expected "${expected}", got "${entered}"`);
    await tab.close();
  }

  await launched.close();
  rmSync(directory, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`FIXTURE_RUN_REPORT {"status":"failed","applied":${applied},"failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`FIXTURE_RUN_REPORT {"status":"passed","applied":${applied},"fields":${form.fields.length}}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
