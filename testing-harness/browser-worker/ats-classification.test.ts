import { describe, expect, it } from "vitest";

import {
  adapterProfileFor,
  adoptablePopup,
  applicationWallReason,
  atsFlowFor,
  chooseApplyEntry,
  chooseConsentControl,
  chooseNavigationEntry,
  classifyAts,
  classifyFieldRole,
  closedPostingNotice,
  greenhouseEmbedTarget,
  hasApplicationFields,
  isCookieBannerCandidate,
  isSensitiveRole,
  multiStepStopReason,
  planAutofill,
  recognizeForm,
  siteWallReason,
  type ApplyEntryCandidate,
  type ConsentCandidate,
  type NavigationEntryCandidate,
  type RawControl
} from "@internship-agent/browser";
import { ATS_KINDS_NEEDING_APPROVAL, type BrowserField } from "@internship-agent/domain";

describe("ATS classification", () => {
  it("recognizes Greenhouse, Lever, Workday, and Handshake patterns", () => {
    expect(classifyAts("https://boards.greenhouse.io/example/jobs/1?gh_jid=1", "Jobs at Example", "Apply via Greenhouse").kind)
      .toBe("greenhouse");
    expect(classifyAts("https://jobs.lever.co/example/abc", "Example - Careers", "Posting-requirements powered by Lever").kind)
      .toBe("lever");
    expect(classifyAts("https://example.wd1.myworkdayjobs.com/Jobs", "Careers", "Visit Candidate Home on Workday").kind)
      .toBe("workday");
    expect(classifyAts("https://app.joinhandshake.com/jobs/9", "Handshake", "Apply on Handshake").kind)
      .toBe("handshake");
  });

  it("falls back to unknown below the confirm threshold", () => {
    const classification = classifyAts("https://careers.example.com/apply", "Apply", "Fill out the form below.");
    expect(classification.kind).toBe("unknown");
    expect(atsFlowFor(classification)).toBe("generic");
  });

  it("asks for confirmation in the middle band and auto-proceeds when confident", () => {
    expect(atsFlowFor({ kind: "greenhouse", confidence: 0.85, signals: [] })).toBe("auto");
    expect(atsFlowFor({ kind: "lever", confidence: 0.5, signals: [] })).toBe("confirm");
  });

  it("describes the Workday portal as multipage with eyes-on pauses", () => {
    expect(adapterProfileFor("workday")?.multipage).toBe(true);
    expect(adapterProfileFor("greenhouse")?.multipage).toBe(false);
    expect(adapterProfileFor("unknown")).toBe(null);
  });

  it("recognizes Oracle Cloud HCM and SmartRecruiters for display, and always asks the candidate to approve", () => {
    const oracle = classifyAts("https://ibwujb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/11167", "Software Engineering Intern - Fixture Careers", "Apply Now");
    expect(oracle.kind).toBe("oracle");
    expect(atsFlowFor(oracle)).toBe("confirm");
    const smart = classifyAts("https://jobs.smartrecruiters.com/FixtureCo/744000000000000-software-intern", "Fixture Co Software Intern | SmartRecruiters", "I'm interested");
    expect(smart.kind).toBe("smartrecruiters");
    expect(atsFlowFor(smart)).toBe("confirm");
    expect(atsFlowFor({ kind: "oracle", confidence: 1, signals: [] })).toBe("confirm");
    expect(atsFlowFor({ kind: "smartrecruiters", confidence: 1, signals: [] })).toBe("confirm");
    expect(adapterProfileFor("oracle")?.multipage).toBe(true);
    expect(adapterProfileFor("smartrecruiters")?.multipage).toBe(true);
    // Greenhouse and Lever keep their automatic band; a posting about Oracle databases is not an Oracle site.
    expect(atsFlowFor(classifyAts("https://job-boards.greenhouse.io/fixture/jobs/1", "Job Application at Fixture", "Powered by Greenhouse"))).toBe("auto");
    expect(classifyAts("https://careers.example.com/jobs/1", "Data Intern", "Experience with Oracle Database and SQL is a plus.").kind).toBe("unknown");
  });

  it("recognizes Ashby's application page from its URL alone, and proceeds automatically", () => {
    // Ashby's page title names the company, and its text says only "Powered by" beside the logo.
    const ashby = classifyAts("https://jobs.ashbyhq.com/brightlane/c89ba377-fab3-4246-a0cf-9d954cf4c862/application", "Software Intern - Hybrid @ Brightlane", "Name\nEmail\nResume\nSubmit Application\nPowered by");
    expect(ashby.kind).toBe("ashby");
    expect(atsFlowFor(ashby)).toBe("auto");
    expect(classifyAts("https://www.fixture.example/careers?ashby_jid=42992916-9ca1-48ca-9378-f4a13ea3733d", "Careers", "Powered by Ashby").kind).toBe("ashby");
    expect(adapterProfileFor("ashby")?.multipage).toBe(false);
  });

  it("recognizes a SmartRecruiters posting at a national laboratory's company slug (LLNL runs)", () => {
    const llnl = classifyAts("https://jobs.smartrecruiters.com/LawrenceLivermoreNationalLaboratory/744000123456789-cybersecurity-undergraduate-intern", "Cybersecurity Undergraduate Intern", "Apply");
    expect(llnl.kind).toBe("smartrecruiters");
    expect(atsFlowFor(llnl)).toBe("confirm");
  });
});

describe("Dover and Rippling", () => {
  it("recognizes Dover's one-page form from its URL and proceeds automatically", () => {
    const dover = classifyAts("https://app.dover.io/apply/job/00000000-0000-4000-8000-0000000000d1/", "Software Engineering Intern", "Apply\nFirst Name *\nEmail *\nResume *\nApply\nJobs powered by");
    expect(dover.kind).toBe("dover");
    expect(dover.confidence).toBe(1);
    expect(atsFlowFor(dover)).toBe("auto");
    expect(adapterProfileFor("dover")?.multipage).toBe(false);
  });

  it("recognizes jobs.dover.com, where app.dover.io application links redirect, and proceeds automatically", () => {
    const dover = classifyAts("https://jobs.dover.com/job/00000000-0000-4000-8000-0000000000d1", "Data Scientist Intern", "Jobs powered by");
    expect(dover.kind).toBe("dover");
    expect(atsFlowFor(dover)).toBe("auto");
  });

  it("recognizes Rippling for display, and always asks the candidate to approve", () => {
    const rippling = classifyAts("https://ats.rippling.com/fixture/jobs/00000000-0000-4000-8000-0000000000e1", "Apply - Software Engineering Intern", "Application: Software Engineering Intern\nApply");
    expect(rippling.kind).toBe("rippling");
    expect(atsFlowFor(rippling)).toBe("confirm");
    expect(atsFlowFor({ kind: "rippling", confidence: 1, signals: [] })).toBe("confirm");
    expect(adapterProfileFor("rippling")?.multipage).toBe(true);
  });

  it("never reads a posting that names Dover Corporation, or a look-alike host, as Dover", () => {
    expect(classifyAts("https://dover.wd5.myworkdayjobs.com/en-US/Dover_Careers/job/Intern_R1", "Engineering Intern - Dover Corporation Careers", "Dover Corporation\nWorkday").kind).toBe("workday");
    expect(classifyAts("https://andover.io/careers", "Careers", "Apply").kind).not.toBe("dover");
    expect(classifyAts("https://andover.com/careers", "Careers", "Apply").kind).not.toBe("dover");
  });
});

describe("Jobvite and iCIMS, and posting pages behind an Apply link", () => {
  const entry = (overrides: Partial<ApplyEntryCandidate> & Pick<ApplyEntryCandidate, "index">): ApplyEntryCandidate => ({
    tag: "a", href: null, texts: [], className: "", frame: 0, ...overrides
  });

  it("recognizes Jobvite and iCIMS for display, and always asks the candidate to approve", () => {
    const jobvite = classifyAts("https://jobs.jobvite.com/fixturerobotics/job/oFixture1", "Software Intern | Fixture Robotics", "Apply\nPowered by Jobvite");
    expect(jobvite.kind).toBe("jobvite");
    expect(atsFlowFor(jobvite)).toBe("confirm");
    const icims = classifyAts("https://careers-x.icims.com/jobs/9001/job", "Software Intern | Careers at Fixture", "Apply for this job online\nSoftware Powered by iCIMS");
    expect(icims.kind).toBe("icims");
    expect(atsFlowFor(icims)).toBe("confirm");
    expect(atsFlowFor({ kind: "jobvite", confidence: 1, signals: [] })).toBe("confirm");
    expect(atsFlowFor({ kind: "icims", confidence: 1, signals: [] })).toBe("confirm");
    expect(adapterProfileFor("jobvite")?.multipage).toBe(true);
    expect(adapterProfileFor("icims")?.multipage).toBe(true);
  });

  it("follows iCIMS's Apply button and none of its share, referral, or social links", () => {
    const page = "https://careers-fixture.icims.com/jobs/9001/job";
    const apply = entry({
      index: 3, frame: 1, className: "iCIMS_Anchor iCIMS_Action_Button iCIMS_ApplyOnlineButton iCIMS_PrimaryButton",
      href: "https://careers-fixture.icims.com/jobs/9001/intern/job?mode=apply&apply=yes&in_iframe=1",
      texts: ["Apply for this job online Apply", "Apply for this job online"]
    });
    const candidates = [
      entry({ index: 0, frame: 1, href: "#", texts: ["Share"], className: "iCIMS_JobShareButton" }),
      entry({ index: 1, frame: 1, href: "https://careers-fixture.icims.com/jobs/9001/intern/referral?in_iframe=1", texts: ["Email this job to a friend Refer", "Email this job to a friend"] }),
      entry({ index: 2, frame: 1, href: "https://www.linkedin.com/shareArticle?url=fixture", texts: ["LinkedIn"] }),
      apply
    ];
    expect(chooseApplyEntry(page, candidates)).toEqual(apply);
  });

  it("follows Jobvite's first /apply link and never its Apply Later mail or share links", () => {
    const page = "https://jobs.jobvite.com/fixturerobotics/job/oFixture1";
    const first = entry({ index: 0, href: "https://jobs.jobvite.com/fixturerobotics/job/oFixture1/apply", texts: ["Apply"], className: "jv-button jv-button-apply" });
    const candidates = [
      entry({ index: 1, href: "mailto:?subject=Apply", texts: ["Apply Later"] }),
      entry({ index: 2, href: "", texts: ["LinkedIn"] }),
      entry({ index: 3, href: "https://jobs.jobvite.com/fixturerobotics/job/oFixture1/apply", texts: ["Apply"], className: "jv-button jv-button-apply" }),
      first
    ];
    expect(chooseApplyEntry(page, candidates)).toEqual(first);
  });

  it("never follows Apply with LinkedIn, Indeed, or a link to another site", () => {
    const page = "https://careers.fixturerobotics.example/jobs/1002";
    expect(chooseApplyEntry(page, [
      entry({ index: 0, tag: "button", texts: ["Apply with LinkedIn"] }),
      entry({ index: 1, href: "https://www.indeed.com/viewjob?jk=fixture", texts: ["Apply on Indeed"] }),
      entry({ index: 2, href: "https://www.linkedin.com/jobs/view/1", texts: ["Apply"] }),
      entry({ index: 3, href: "https://jobs.example-aggregator.com/fixture/1", texts: ["Apply"] })
    ])).toBeNull();
  });

  it("prefers the same site, and accepts a known ATS host", () => {
    const page = "https://careers.fixturerobotics.example/jobs/1001";
    const own = entry({ index: 1, href: "https://careers.fixturerobotics.example/jobs/1001/apply", texts: ["Apply Now"] });
    const greenhouse = entry({ index: 0, href: "https://boards.greenhouse.io/fixturerobotics/jobs/1", texts: ["Apply"] });
    expect(chooseApplyEntry(page, [greenhouse, own])).toEqual(own);
    expect(chooseApplyEntry(page, [greenhouse])).toEqual(greenhouse);
  });

  it("names iCIMS's account step and Jobvite's data-consent step, and nothing else", () => {
    expect(applicationWallReason("https://careers-fixture.icims.com/jobs/9001/intern/login?in_iframe=1", "Enter Your Information\nEmail"))
      .toMatch(/^iCIMS needs an account at careers-fixture\.icims\.com before its application form/);
    expect(applicationWallReason("https://jobs.jobvite.com/fixturerobotics/job/oFixture1/apply", "Data Consent\nLocation of Residence and Language:"))
      .toMatch(/^Jobvite asks you to accept its data-consent policy at jobs\.jobvite\.com/);
    expect(applicationWallReason("https://job-boards.greenhouse.io/fixture/jobs/1", "Data Consent")).toBeNull();
    expect(applicationWallReason("https://careers-fixture.icims.com/jobs/9001/job", "Apply for this job online")).toBeNull();
  });

  it("follows SmartRecruiters I'm interested and Im interested buttons and links on LLNL and ServiceNow postings", () => {
    const llnlPage = "https://jobs.smartrecruiters.com/LawrenceLivermoreNationalLaboratory/744000123456789-cybersecurity-undergraduate-intern";
    const llnlApply = entry({
      index: 1,
      tag: "a",
      href: "https://jobs.smartrecruiters.com/oneclick-ui/company/LawrenceLivermoreNationalLaboratory/publication/744000123456789",
      texts: ["I'm interested"],
      className: "js-oneclick"
    });
    const llnlCandidates = [
      entry({ index: 0, href: "#", texts: ["Share this job"], className: "share-btn" }),
      llnlApply,
      entry({ index: 2, href: "https://www.linkedin.com/sharing/share-offsite", texts: ["Share on LinkedIn"] })
    ];
    expect(chooseApplyEntry(llnlPage, llnlCandidates)).toEqual(llnlApply);

    // ServiceNow button with "Im interested" (no apostrophe) and curly apostrophe "I’m interested"
    const serviceNowPage = "https://jobs.smartrecruiters.com/ServiceNow/744000000000001-software-intern";
    const serviceNowButton = entry({
      index: 0,
      tag: "button",
      texts: ["Im interested"],
      className: "st-apply"
    });
    expect(chooseApplyEntry(serviceNowPage, [serviceNowButton])).toEqual(serviceNowButton);

    const curlyApostropheButton = entry({
      index: 0,
      tag: "button",
      texts: ["I’m interested"],
      className: "st-apply"
    });
    expect(chooseApplyEntry(serviceNowPage, [curlyApostropheButton])).toEqual(curlyApostropheButton);
  });

  it("handles cookie banner overlays and never chooses OneTrust, Privacy Preference Center, or cookie allow/accept as Apply entry", () => {
    const page = "https://jobs.smartrecruiters.com/ServiceNow/744000000000001-software-intern";
    const onetrustAccept = entry({
      index: 0,
      tag: "button",
      id: "onetrust-accept-btn-handler",
      texts: ["Accept All Cookies"],
      className: "onetrust-close-btn-handler"
    });
    const privacyPref = entry({
      index: 1,
      tag: "button",
      texts: ["Confirm My Choices"],
      className: "save-preference-btn-handler onetrust-close-btn-handler"
    });
    const cookieAllow = entry({
      index: 2,
      tag: "button",
      id: "cookie-allow-all",
      texts: ["Allow"],
      className: "cookie-banner-accept"
    });
    const applyEntry = entry({
      index: 3,
      tag: "a",
      href: "https://jobs.smartrecruiters.com/oneclick-ui/company/ServiceNow/publication/00000000-0000-4000-8000-000000000000",
      texts: ["I'm interested"],
      className: "js-oneclick"
    });

    // Alone, cookie banner candidates are never chosen
    expect(chooseApplyEntry(page, [onetrustAccept, privacyPref, cookieAllow])).toBeNull();

    // isCookieBannerCandidate classifies each overlay element
    expect(isCookieBannerCandidate(onetrustAccept)).toBe(true);
    expect(isCookieBannerCandidate(privacyPref)).toBe(true);
    expect(isCookieBannerCandidate(cookieAllow)).toBe(true);
    expect(isCookieBannerCandidate(applyEntry)).toBe(false);

    // When appearing before the real apply entry, the apply entry is reached rather than halted
    expect(chooseApplyEntry(page, [onetrustAccept, privacyPref, cookieAllow, applyEntry])).toEqual(applyEntry);

  });
});

describe("company careers pages: embedded Greenhouse, new-tab entries, closed postings", () => {
  const PAGE = "https://careers.fixturehealth.example/careers/jobs/7000002-intern?gh_jid=7000002";
  const EMBED = "https://job-boards.greenhouse.io/embed/job_app?for=fixturehealth&token=7000002";

  it("opens the Greenhouse application the page itself embeds, and never a guessed board", () => {
    expect(greenhouseEmbedTarget(PAGE, [PAGE, EMBED])).toBe(EMBED);
    // The embed's job must be the page's own job.
    expect(greenhouseEmbedTarget("https://careers.fixturehealth.example/careers/jobs?gh_jid=7000009", [EMBED])).toBeNull();
    // Greenhouse's embed script plus the page's gh_jid: the application that script builds.
    expect(greenhouseEmbedTarget("https://careers.fixturehealth.example/careers/jobs?gh_jid=7000003", ["https://boards.greenhouse.io/embed/job_board/js?for=fixturehealth"]))
      .toBe("https://job-boards.greenhouse.io/embed/job_app?for=fixturehealth&token=7000003");
    expect(greenhouseEmbedTarget("https://careers.fixturehealth.example/careers/jobs", ["https://boards.greenhouse.io/embed/job_board/js?for=fixturehealth"])).toBeNull();
    expect(greenhouseEmbedTarget("https://careers.fixturehealth.example/careers/jobs?gh_jid=7000003", [
      "https://boards.greenhouse.io/embed/job_board/js?for=fixturehealth",
      "https://boards.greenhouse.io/embed/job_board/js?for=otherboard"
    ])).toBeNull();
    expect(greenhouseEmbedTarget(PAGE, ["https://job-boards.greenhouse.io.evil.example/embed/job_app?for=fixturehealth&token=7000002"])).toBeNull();
    expect(greenhouseEmbedTarget(PAGE, ["http://job-boards.greenhouse.io/embed/job_app?for=fixturehealth&token=7000002"])).toBeNull();
    expect(greenhouseEmbedTarget(PAGE, ["https://job-boards.greenhouse.io/embed/job_app?for=../x&token=7000002"])).toBeNull();
    expect(greenhouseEmbedTarget(PAGE, ["https://boards.greenhouse.io/embed/job_app?for=fixturehealth&token=7000002"]))
      .toBe("https://boards.greenhouse.io/embed/job_app?for=fixturehealth&token=7000002");
    expect(greenhouseEmbedTarget("https://careers.fixturehealth.example/careers/jobs?gh_jid=7000004", ["https://boards.eu.greenhouse.io/embed/job_board/js?for=fixturehealth"]))
      .toBe("https://job-boards.eu.greenhouse.io/embed/job_app?for=fixturehealth&token=7000004");
  });

  it("follows a new tab only to the same site, the company domain, or a known ATS host", () => {
    const POSTING = "https://jobs.fixturechips.example/careers/job/900001";
    const WORKDAY = "https://fixturechips.wd5.myworkdayjobs.com/External/job/US-CA-Santa-Clara/Robotics-Intern_JR1000001?source=Eightfold";
    expect(adoptablePopup(POSTING, [WORKDAY])).toBe(WORKDAY);
    expect(adoptablePopup(POSTING, ["https://www.jobaggregator.example/job/900001"])).toBeNull();
    expect(adoptablePopup(POSTING, [WORKDAY, WORKDAY])).toBeNull();
    expect(adoptablePopup(POSTING, ["about:blank"])).toBeNull();
    expect(adoptablePopup(POSTING, ["http://fixturechips.wd5.myworkdayjobs.com/External/job/X_JR1"])).toBeNull();
    expect(adoptablePopup(POSTING, [])).toBeNull();
  });

  it("names a posting page that says the job is closed", () => {
    expect(closedPostingNotice("Fixture Devices Careers\nThe page you are looking for no longer exists. We're sorry, but it looks like this job may be no longer available or does not exist."))
      .toBe("The page you are looking for no longer exists");
    expect(closedPostingNotice("Fixture Engineering\nWe’re sorry, that job does not exist or is not currently active.")).toBe("that job does not exist or is not currently active");
    expect(closedPostingNotice("The job you are looking for is no longer open.")).toBe("The job you are looking for is no longer open");
    expect(closedPostingNotice("Software Engineering Intern\nAbout the role: build robots.\nApply")).toBeNull();
  });
});

describe("Paylocity", () => {
  it("recognizes recruiting.paylocity.com for display, and always asks the candidate to approve", () => {
    const paylocity = classifyAts("https://recruiting.paylocity.com/Recruiting/Jobs/Details/1000001", "Robotics Software Intern", "Apply\nPowered by\nPaylocity Privacy Policy");
    expect(paylocity.kind).toBe("paylocity");
    expect(atsFlowFor(paylocity)).toBe("confirm");
    expect(adapterProfileFor("paylocity")?.multipage).toBe(true);
    // A posting that names Paylocity the company on another site is not a Paylocity site.
    expect(classifyAts("https://careers.fixturerobotics.example/jobs/1001", "Software Intern at Paylocity", "Paylocity is hiring an intern.").kind).toBe("unknown");
  });

  it("keeps every kind left in the approval set on the confirm flow", () => {
    for (const kind of ATS_KINDS_NEEDING_APPROVAL) {
      expect(atsFlowFor({ kind: kind as Parameters<typeof atsFlowFor>[0]["kind"], confidence: 1, signals: [] })).toBe("confirm");
    }
    expect([...ATS_KINDS_NEEDING_APPROVAL].sort()).toEqual(["icims", "jobvite", "oracle", "paylocity", "rippling", "smartrecruiters"]);
  });
});

describe("cookie consent is rejected, never accepted", () => {
  const consent = (overrides: Partial<ConsentCandidate> & Pick<ConsentCandidate, "index">): ConsentCandidate => ({
    id: "", className: "", texts: [], optionalGroupsOff: false, ...overrides
  });
  const accept = consent({ index: 0, id: "onetrust-accept-btn-handler", className: "onetrust-close-btn-handler", texts: ["Accept All Cookies"] });

  it("clicks OneTrust's Reject All over its Accept All Cookies", () => {
    const reject = consent({ index: 1, id: "onetrust-reject-all-handler", texts: ["Reject All"] });
    expect(chooseConsentControl([accept, reject])).toEqual({ index: 1, kind: "reject", text: "Reject All" });
  });

  it("clicks nothing on a banner that offers only accept, even with OneTrust's close-handler class on it", () => {
    expect(chooseConsentControl([accept])).toBeNull();
    expect(chooseConsentControl([consent({ index: 0, texts: ["Allow all"] }), consent({ index: 1, texts: ["Got it"] })])).toBeNull();
    expect(chooseConsentControl([consent({ index: 0, id: "onetrust-pc-btn-handler", className: "cookie-setting-link", texts: ["Cookies Settings"] })])).toBeNull();
  });

  it("takes necessary-only, and Confirm My Choices only with every optional group off", () => {
    expect(chooseConsentControl([accept, consent({ index: 1, texts: ["Necessary only"] })])?.kind).toBe("necessary");
    const confirm = { index: 1, className: "save-preference-btn-handler onetrust-close-btn-handler", texts: ["Confirm My Choices"] };
    expect(chooseConsentControl([accept, consent({ ...confirm, optionalGroupsOff: false })])).toBeNull();
    expect(chooseConsentControl([accept, consent({ ...confirm, optionalGroupsOff: true })])).toEqual({ index: 1, kind: "necessary", text: "Confirm My Choices" });
  });

  it("closes the banner only when no reject or necessary-only control exists", () => {
    const close = consent({ index: 1, className: "onetrust-close-btn-handler onetrust-close-btn-ui banner-close-button ot-close-icon", texts: ["Close"] });
    expect(chooseConsentControl([accept, close])?.kind).toBe("close");
    expect(chooseConsentControl([accept, consent({ index: 1, texts: ["×"] })])?.kind).toBe("close");
    expect(chooseConsentControl([consent({ index: 0, texts: ["×"] }), consent({ index: 1, texts: ["Decline"] })])?.kind).toBe("reject");
  });

  it("clicks Cookiebot's decline button", () => {
    const allow = consent({ index: 0, id: "CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", texts: ["Allow all"] });
    const decline = consent({ index: 1, id: "CybotCookiebotDialogBodyButtonDecline", texts: ["Deny"] });
    expect(chooseConsentControl([allow, decline])?.index).toBe(1);
    expect(chooseConsentControl([allow, consent({ index: 1, id: "CybotCookiebotDialogBodyButtonDecline", texts: [] })])?.kind).toBe("reject");
  });
});

describe("site navigation", () => {
  const field = (overrides: Partial<BrowserField> & Pick<BrowserField, "id" | "label">): BrowserField => ({ kind: "text", required: false, ...overrides });
  const nav = (overrides: Partial<NavigationEntryCandidate> & Pick<NavigationEntryCandidate, "index">): NavigationEntryCandidate => ({
    tag: "button", href: null, texts: [], className: "", frame: 0, submitsForm: false, ...overrides
  });
  const PAGE = "https://careers.fixturerobotics.example/jobs/1001";

  it("counts identity, resume, and work-authorization fields as an application form, and nothing else", () => {
    expect(hasApplicationFields([field({ id: "first", label: "First Name" })])).toBe(true);
    expect(hasApplicationFields([field({ id: "email", label: "Email", kind: "email" })])).toBe(true);
    expect(hasApplicationFields([field({ id: "resume", label: "Resume", kind: "file" })])).toBe(true);
    expect(hasApplicationFields([
      field({ id: "copy-link-1", label: "Copy link" }),
      field({ id: "q", label: "Search jobs" }),
      field({ id: "alert", label: "Email me job alerts", kind: "email" }),
      field({ id: "ot-group-id-C0002", label: "Performance Cookies", kind: "checkbox" }),
      field({ id: "start", label: "What is your available start date?" })
    ])).toBe(false);
  });

  it("prefers a guest choice and never follows sign-in, account creation, third-party apply, sharing, cookies, or a form's submit", () => {
    const signIn = nav({ index: 0, texts: ["Sign in"] });
    const create = nav({ index: 1, texts: ["Create account"] });
    const linkedin = nav({ index: 2, texts: ["Apply with LinkedIn"] });
    const guest = nav({ index: 3, texts: ["Apply as guest"] });
    expect(chooseNavigationEntry(PAGE, [signIn, create, linkedin, guest], new Set(), false)).toEqual({ candidate: guest, kind: "guest" });
    expect(chooseNavigationEntry(PAGE, [signIn, create, linkedin], new Set(), false)).toBeNull();
    expect(chooseNavigationEntry(PAGE, [nav({ index: 0, texts: ["Share"] }), nav({ index: 1, id: "onetrust-accept-btn-handler", texts: ["Accept All Cookies"] })], new Set(), false)).toBeNull();
    const submit = nav({ index: 0, texts: ["Continue"], submitsForm: true });
    expect(chooseNavigationEntry(PAGE, [submit], new Set(), false)).toBeNull();
    expect(chooseNavigationEntry(PAGE, [nav({ index: 0, texts: ["Apply"], submitsForm: true })], new Set(), false)).toBeNull();
  });

  it("follows the posting's Apply, then manual, and continue only on a page with no question", () => {
    const apply = nav({ index: 1, tag: "a", href: `${PAGE}/apply`, texts: ["Apply"] });
    const manual = nav({ index: 2, texts: ["Apply manually"] });
    const proceed = nav({ index: 3, texts: ["Continue"] });
    expect(chooseNavigationEntry(PAGE, [proceed, manual, apply], new Set(), false)?.kind).toBe("apply");
    expect(chooseNavigationEntry(PAGE, [proceed, manual], new Set(), false)?.kind).toBe("manual");
    expect(chooseNavigationEntry(PAGE, [proceed], new Set(), false)).toEqual({ candidate: proceed, kind: "advance" });
    expect(chooseNavigationEntry(PAGE, [proceed], new Set(), true)).toBeNull();
  });

  it("skips an entry already followed and a link to another site", () => {
    const apply = nav({ index: 0, tag: "a", href: `${PAGE}/apply`, texts: ["Apply"] });
    expect(chooseNavigationEntry(PAGE, [apply], new Set([`${PAGE}/apply`]), false)).toBeNull();
    const guest = nav({ index: 0, texts: ["Continue as guest"] });
    expect(chooseNavigationEntry(PAGE, [guest], new Set([`${PAGE}#Continue as guest`]), false)).toBeNull();
    expect(chooseNavigationEntry(PAGE, [nav({ index: 0, tag: "a", href: "https://jobs.aggregator.example/apply/1", texts: ["Apply"] })], new Set(), false)).toBeNull();
  });

  it("names Oracle Cloud HCM's email step as a wall, and no other page", () => {
    const oracle = "https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001";
    expect(siteWallReason(`${oracle}/apply/email`, [field({ id: "primary-email", label: "Email Address", kind: "email" })]))
      .toBe("Oracle Cloud HCM asks for your email at fixture.fa.ocs.oraclecloud.com, then emails you a one-time code, before its application form; the agent does not take that step yet. Apply in your own browser.");
    expect(siteWallReason(oracle, [])).toBeNull();
    expect(siteWallReason("https://careers.fixturerobotics.example/apply/email", [field({ id: "email", label: "Email", kind: "email" })])).toBeNull();
  });

  it("stops at a page with Next and no submit, never at one that shows a submit", () => {
    expect(multiStepStopReason("https://careers.fixturerobotics.example/apply", { submit: false, next: "Next" }))
      .toBe("The application at careers.fixturerobotics.example continues over several pages (its button says \"Next\"), and the agent fills several-page forms only on sites it has an adapter for. Finish this application in your own browser.");
    expect(multiStepStopReason("https://careers.fixturerobotics.example/apply", { submit: true, next: "Next" })).toBeNull();
    expect(multiStepStopReason("https://careers.fixturerobotics.example/apply", { submit: false, next: null })).toBeNull();
  });
});

describe("canonical field roles", () => {
  it("marks demographic questions sensitive", () => {
    expect(classifyFieldRole({ id: "g", label: "Gender", kind: "select", required: false })).toBe("eeo");
    expect(classifyFieldRole({ id: "v", label: "Veteran status", kind: "radio", required: true })).toBe("eeo");
    expect(classifyFieldRole({ id: "r", label: "How would you describe your racial/ethnic background? (mark all that apply)", kind: "select", required: false })).toBe("eeo");
    expect(isSensitiveRole("eeo")).toBe(true);
    expect(isSensitiveRole("email")).toBe(false);
  });

  it("pauses sensitive fields even when memory could answer", () => {
    const form = recognizeForm("https://example.com/apply", "Apply", [
      { tag: "select", id: "gender", label: "Gender", options: ["A", "B"] } as RawControl
    ]);
    const plan = planAutofill(form, {
      profile: {},
      resolutions: new Map(),
      packageAnswers: [],
      variantId: null
    });
    expect(plan.decisions[0]?.action).toBe("pause");
    expect(plan.pauses[0]?.sensitive).toBe(true);
  });
});
