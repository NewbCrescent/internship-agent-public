import { describe, expect, it } from "vitest";

import {
  adapterProfileFor,
  applicationWallReason,
  atsFlowFor,
  chooseApplyEntry,
  classifyAts,
  classifyFieldRole,
  dismissCookieBannerIn,
  isCookieBannerCandidate,
  isSensitiveRole,
  planAutofill,
  recognizeForm,
  type ApplyEntryCandidate,
  type RawControl
} from "@internship-agent/browser";

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

    // dismissCookieBannerIn clicks the OneTrust accept button and hides the overlay
    let otClicked = false;
    const fakeOtButton = { click: () => { otClicked = true; } };
    const fakeDarkFilter = { style: { display: "block" } };
    const fakeDoc = {
      querySelector: (selector: string) => {
        if (selector.includes("onetrust-accept-btn-handler")) return fakeOtButton;
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("onetrust-consent-sdk")) return [fakeDarkFilter];
        return [];
      }
    };
    expect(dismissCookieBannerIn(fakeDoc as unknown as Document)).toBe(true);
    expect(otClicked).toBe(true);
    expect(fakeDarkFilter.style.display).toBe("none");
  });
});

describe("canonical field roles", () => {
  it("marks demographic questions sensitive", () => {
    expect(classifyFieldRole({ id: "g", label: "Gender", kind: "select", required: false })).toBe("eeo");
    expect(classifyFieldRole({ id: "v", label: "Veteran status", kind: "radio", required: true })).toBe("eeo");
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
