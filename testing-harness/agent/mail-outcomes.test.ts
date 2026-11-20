import { describe, expect, it } from "vitest";

import {
  atsTenant,
  classifyOutcome,
  companyKey,
  evaluateMail,
  findDeadline,
  formatMailNotice,
  htmlToText,
  mailEventDetail,
  mailItemKey,
  matchApplication,
  relevantHeader,
  senderDomain,
  type AppliedJob,
  type MailHeader,
  type MailItem
} from "../../packages/agent/src/mail-outcomes";
import { mailWatchLaunchdPlist, mailWatchSystemdService } from "../../packages/agent/src/mail-schedule";

/**
 * Synthetic emails only (fictional companies): proves the deterministic
 * contract of the Gmail outcome rules, not real-world accuracy.
 */
const ACME: AppliedJob = {
  id: "a1c3e000-0000-4000-8000-000000000001",
  companyName: "Acme Robotics, Inc.",
  title: "Software Engineering Intern",
  status: "SUBMITTED",
  submitted: true,
  sourceUrl: "https://boards.greenhouse.io/acmerobotics/jobs/123",
  externalApplicationUrl: null
};
const GLOBEX: AppliedJob = {
  id: "9b0be000-0000-4000-8000-000000000002",
  companyName: "Globex",
  title: "Data Science Intern",
  status: "APPLYING",
  submitted: false,
  sourceUrl: "https://github.com/example/list#globex",
  externalApplicationUrl: "https://globex.wd5.myworkdayjobs.com/en-US/careers/job/123"
};
const JOBS = [ACME, GLOBEX];
const RECEIVED = new Date("2026-11-18T17:00:00Z");
const SENTINEL = "BODY-SENTINEL-7f3a";

function header(overrides: Partial<MailHeader>): MailHeader {
  return {
    uid: 10, messageId: "<m1@example.test>", fromName: "", fromAddress: "someone@example.test",
    subject: "", receivedAt: RECEIVED, bulk: false, ...overrides
  };
}

function evaluate(overrides: Partial<MailHeader>, body: string, jobs: AppliedJob[] = JOBS): MailItem | null {
  return evaluateMail({ header: header(overrides), body, jobs, uidValidity: "7" });
}

const HACKERRANK = {
  fromName: "Acme Robotics Hiring Team",
  fromAddress: "no-reply@hackerrankforwork.com",
  subject: "Acme Robotics invites you to a coding test"
};
const HACKERRANK_BODY = `Hi, please complete the test by Wednesday, November 25, 2026 at 11:59 PM PST. Your link is private. ${SENTINEL}`;

describe("helpers", () => {
  it("normalizes company names, sender domains, ATS tenants, and HTML", () => {
    expect(companyKey("The Acme Robotics, Inc.")).toBe("acme robotics");
    expect(companyKey("Ben & Jerry's Holdings LLC")).toBe("ben and jerry s");
    expect(companyKey("Café Labs")).toBe("cafe");
    expect(senderDomain("No-Reply@Us.Greenhouse-Mail.IO")).toBe("us.greenhouse-mail.io");
    expect(senderDomain("not an address")).toBe("");
    expect(atsTenant("https://boards.greenhouse.io/acmerobotics/jobs/1")).toBe("acmerobotics");
    expect(atsTenant("https://jobs.lever.co/Acme-Robotics/abc")).toBe("acmerobotics");
    expect(atsTenant("https://globex.wd5.myworkdayjobs.com/x")).toBe("globex");
    expect(atsTenant("https://jobs.ashbyhq.com/ab")).toBeNull();
    expect(atsTenant("not a url")).toBeNull();
    expect(htmlToText("<style>p{}</style><p>Hello&nbsp;<b>there</b> &amp; &#39;you&#39;</p><script>x()</script>")).toBe("Hello there & 'you'");
  });
});

describe("classification", () => {
  it("reads a HackerRank invite as an urgent assessment with its deadline", () => {
    const item = evaluate(HACKERRANK, HACKERRANK_BODY);
    expect(item?.category).toBe("assessment");
    expect(item?.deadline).toEqual({ text: "Wednesday, November 25, 2026 at 11:59 PM PST", date: "2026-11-25" });
    expect(item?.match.via).toBe("sender");
    expect(item?.match.jobs.map((job) => job.id)).toEqual([ACME.id]);
  });

  it("computes a relative deadline from the received time", () => {
    expect(findDeadline("Please complete the assessment within 72 hours.", RECEIVED)).toEqual({ text: "within 72 hours", date: "2026-11-21" });
    expect(findDeadline("The link expires in 5 business days.", RECEIVED)).toEqual({ text: "within 5 business days", date: null });
    expect(findDeadline("Due by 12/2/2026 11:59pm", RECEIVED)).toEqual({ text: "12/2/2026 11:59pm", date: "2026-12-02" });
    expect(findDeadline("Deadline: Jan 5", RECEIVED)).toEqual({ text: "Jan 5", date: "2027-01-05" });
    expect(findDeadline("Join us on November 25 for a meetup.", RECEIVED)).toBeNull();
  });

  it("reads rejections first, even when they mention interviews or assessments", () => {
    const rejection = evaluate(
      { fromName: "Greenhouse", fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Your application to Acme Robotics" },
      `Thank you for your interest. Unfortunately we will not be moving forward with your application. ${SENTINEL}`
    );
    expect(rejection?.category).toBe("rejection");
    expect(rejection?.match.via).toBe("subject");
    const mixed = evaluate(
      { fromAddress: "talent@acmerobotics.com", subject: "Update on your Acme Robotics interview" },
      "After your interview and online assessment, we regret to inform you that we have decided to pursue other candidates."
    );
    expect(mixed?.category).toBe("rejection");
  });

  it("reads interview invites from the employer and from scheduling tools", () => {
    expect(evaluate({ fromAddress: "talent@acmerobotics.com", subject: "Next steps" },
      "We would like to schedule an interview. Pick a slot at https://calendly.com/acme-recruiting/30min")?.category).toBe("interview");
    expect(evaluate({ fromAddress: "notifications@calendly.com", subject: "Acme Robotics: pick a time" }, "Choose a slot below.")?.category)
      .toBe("interview");
  });

  it("reads offers and ignores marketing offers", () => {
    expect(evaluate({ fromAddress: "people@acmerobotics.com", subject: "Your internship" },
      "We are pleased to offer you the Software Engineering Intern position.")?.category).toBe("offer");
    expect(evaluate({ fromAddress: "deals@acmerobotics.com", subject: "A special offer for you", bulk: true },
      "Get 20% off our robot kits. Special offer ends soon.")).toBeNull();
  });

  it("reads a personal recruiter reply", () => {
    expect(evaluate({ fromName: "Jordan Lee", fromAddress: "jordan@acmerobotics.com", subject: "About your application" },
      "Hi, thanks for reaching out about the role. Could you share your graduation date?")?.category).toBe("recruiter");
  });

  it("ignores receipts and account emails", () => {
    expect(evaluate({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Thank you for applying to Acme Robotics" },
      "Thank you for applying. We will review your application.")).toBeNull();
    expect(evaluate({ fromAddress: "globex@myworkday.com", subject: "Verify your email" },
      "Please verify your email to activate your Globex candidate account.")).toBeNull();
    expect(evaluate({ fromAddress: "support@hackerrankforwork.com", subject: "Acme Robotics coding test" },
      "Thank you for completing the test. Your results were shared with the team.")).toBeNull();
  });

  it("reads security and verification code emails as verification, never as a recruiter reply, and never keeps a code", () => {
    const greenhouse = evaluate({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme Robotics" },
      `Copy and paste this code into the security code field on your application: Xy7Qp2Lm. ${SENTINEL}`);
    expect(greenhouse?.category).toBe("verification");
    expect(greenhouse?.match.jobs).toEqual([ACME]);
    expect(mailEventDetail(greenhouse!)).toBe("Email received: Verification code from us.greenhouse-mail.io: \"Security code for your application to Acme Robotics\"");
    expect(evaluate({ fromAddress: "globex@myworkday.com", subject: "Verify your account" },
      "Use this link to verify your Globex candidate account for your application.")?.category).toBe("verification");
    const coded = evaluate({ fromAddress: "talent@acmerobotics.com", subject: "Your Acme Robotics verification code is 482913" }, "Enter it to continue your application.");
    expect(coded?.category).toBe("verification");
    expect(coded?.subject).toBe("Your Acme Robotics verification code is [code]");
    expect(mailEventDetail(coded!)).not.toContain("482913");
    expect(evaluate({ fromAddress: "talent@acmerobotics.com", subject: "AB12-CD34 is your one-time code" }, "For your application.")?.subject)
      .toBe("[code] is your one-time code");
    expect(evaluate({ fromAddress: "talent@acmerobotics.com", subject: "About your application" },
      "Here is the one-time code for your application portal.")?.category).toBe("verification");
    // A real outcome that mentions a code only in its body keeps its category.
    expect(evaluate({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Your application to Acme Robotics" },
      "We will not be moving forward. Your security code is no longer needed.")?.category).toBe("rejection");
  });

  it("ignores newsletters and job boards", () => {
    const newsletter = header({ fromAddress: "digest@newsletter-careers.example", subject: "Interview tips: how Acme Robotics hires", bulk: true });
    const notRelevant = !relevantHeader(newsletter, JOBS, "candidate@example.test");
    const nothing = evaluateMail({ header: newsletter, body: "Five interview tips. Schedule an interview with confidence.", jobs: JOBS, uidValidity: "7" }) === null;
    expect(notRelevant || nothing).toBe(true);
    expect(nothing).toBe(true);
    const board = header({ fromAddress: "jobs-noreply@linkedin.com", subject: "Acme Robotics is hiring: interview now" });
    expect(relevantHeader(board, JOBS, "candidate@example.test")).toBe(false);
    expect(relevantHeader(header({ fromAddress: "Candidate@Example.test", subject: "Acme Robotics interview" }), JOBS, "candidate@example.test")).toBe(false);
    expect(relevantHeader(header({ fromAddress: "no-reply@hackerrankforwork.com" }), JOBS, "candidate@example.test")).toBe(true);
  });

  it("matches a Workday sender by its tenant, as a started application", () => {
    const item = evaluate({ fromAddress: "globex@myworkday.com", subject: "Interview invitation" }, "We would like to interview you next week.");
    expect(item?.category).toBe("interview");
    expect(item?.match.jobs).toEqual([GLOBEX]);
    expect(formatMailNotice([item!])).toContain(`Globex — Data Science Intern (job ${GLOBEX.id.slice(0, 8)}, started)`);
  });

  it("keeps two applications to one company ambiguous unless the title decides", () => {
    const second: AppliedJob = { ...ACME, id: "a1c3e000-0000-4000-8000-000000000003", title: "Firmware Intern" };
    const jobs = [ACME, second];
    const generic = evaluate({ fromAddress: "talent@acmerobotics.com", subject: "Next steps" }, "We would like to schedule an interview.", jobs);
    expect(generic?.match.jobs).toHaveLength(2);
    expect(formatMailNotice([generic!])).toContain("Acme Robotics, Inc. (2 applications: job a1c3e000, job a1c3e000)");
    const titled = evaluate({ fromAddress: "talent@acmerobotics.com", subject: "Next steps: Firmware Intern" }, "We would like to schedule an interview.", jobs);
    expect(titled?.match.jobs.map((job) => job.id)).toEqual([second.id]);
  });

  it("prefers submitted applications to started ones of the same company", () => {
    const started: AppliedJob = { ...ACME, id: "a1c3e000-0000-4000-8000-000000000004", status: "APPLYING", submitted: false, title: "Robotics Intern" };
    const match = matchApplication({ header: header({ fromAddress: "talent@acmerobotics.com" }), body: "" }, [started, ACME]);
    expect(match?.jobs).toEqual([ACME]);
  });

  it("ignores companies the candidate never applied to", () => {
    expect(evaluate({ fromAddress: "talent@initech.example", subject: "Initech interview invitation" }, "We would like to schedule an interview.")).toBeNull();
    expect(classifyOutcome({ header: header({ subject: "hello" }), body: "nothing", senderDomain: "example.test", matchedVia: "body" })).toBeNull();
  });
});

describe("DM text", () => {
  it("puts assessments first with the deadline first, redacts subjects, and never carries the body", () => {
    const assessment = evaluate({ ...HACKERRANK, subject: "Acme Robotics test for candidate@example.test ref 123456789" }, HACKERRANK_BODY)!;
    const rejection = evaluate({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Your application to Acme Robotics", uid: 11, messageId: "<m2@x>" },
      `We will not be moving forward. ${SENTINEL}`)!;
    const text = formatMailNotice([rejection, assessment]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Internship agent: 2 new emails about your applications");
    expect(text.indexOf("URGENT: online assessment")).toBeLessThan(text.indexOf("Rejection"));
    const urgentLine = lines[lines.indexOf("URGENT: online assessment") + 1]!;
    expect(urgentLine.startsWith("• Deadline: Wednesday, November 25, 2026 at 11:59 PM PST, Acme Robotics, Inc. — Software Engineering Intern")).toBe(true);
    expect(urgentLine).toContain(`job ${ACME.id.slice(0, 8)}, submitted`);
    expect(text).toContain("\"Acme Robotics test for [email] ref [number]\" from hackerrankforwork.com");
    expect(text).toContain("from us.greenhouse-mail.io");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("candidate@example.test");
    expect(mailEventDetail(assessment)).toBe(
      "Email received: Online assessment (deadline Wednesday, November 25, 2026 at 11:59 PM PST) from hackerrankforwork.com: \"Acme Robotics test for [email] ref [number]\""
    );
    expect(mailEventDetail(rejection)).toBe("Email received: Rejection from us.greenhouse-mail.io: \"Your application to Acme Robotics\"");
  });

  it("leaves verification emails out of the DM", () => {
    const code = evaluate({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme Robotics" }, "Code: Xy7Qp2Lm")!;
    const reply = evaluate({ fromName: "Jordan Lee", fromAddress: "jordan@acmerobotics.com", subject: "About your application", uid: 12, messageId: "<m3@x>" },
      "Hi, thanks for reaching out about the role.")!;
    const text = formatMailNotice([code, reply]);
    expect(text.split("\n")[0]).toBe("Internship agent: 1 new email about your applications");
    expect(text).toContain("Recruiter reply");
    expect(text).not.toContain("Security code");
    expect(text).not.toContain("Xy7Qp2Lm");
  });

  it("keys items by a digest of the Message-ID, case- and space-insensitive, with a UID fallback", () => {
    const a = mailItemKey(header({ messageId: " <ABC@Example.test> " }), "7");
    expect(a).toBe(mailItemKey(header({ messageId: "<abc@example.test>", uid: 99 }), "8"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("abc");
    const fallback = mailItemKey(header({ messageId: null, uid: 5 }), "7");
    expect(fallback).not.toBe(mailItemKey(header({ messageId: null, uid: 5 }), "8"));
    expect(fallback).toBe(mailItemKey(header({ messageId: "  ", uid: 5 }), "7"));
  });
});

describe("watcher service", () => {
  it("renders a systemd user service with Restart=always and a launchd KeepAlive agent", () => {
    const service = mailWatchSystemdService({ repository: "/home/me/100% repo's", profile: "real" });
    expect(service).toContain("Restart=always");
    expect(service).toContain("WantedBy=default.target");
    expect(service).toContain("Type=simple");
    expect(service).toContain("cd '/home/me/100%% repo'\\\\''s' && exec pnpm mail:watch --profile real");
    expect(service).not.toContain("[Timer]");
    const plist = mailWatchLaunchdPlist({ repository: "/Users/me/repo", profile: "demo", logDirectory: "/Users/me/data/mail-logs/" });
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<string>com.internship-agent.mail.demo</string>");
    expect(plist).toContain("/Users/me/data/mail-logs/launchd.log");
    expect(plist).not.toContain("StartInterval");
  });
});
