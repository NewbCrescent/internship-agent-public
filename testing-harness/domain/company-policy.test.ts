import { describe, expect, it } from "vitest";

import {
  companyCapReason,
  companyCapSetting,
  companyIdentities,
  normalizeCompanyName,
  pinnedProfile,
  profileOfRun,
  runStartedByPipeline,
  sharesCompany
} from "@internship-agent/domain";

describe("company identity", () => {
  it("ignores case, punctuation, a leading article, and trailing legal suffixes", () => {
    expect(normalizeCompanyName("Vandelay Inc.")).toBe("vandelay");
    expect(normalizeCompanyName("Vandelay")).toBe("vandelay");
    expect(normalizeCompanyName("VANDELAY, INC")).toBe("vandelay");
    expect(normalizeCompanyName("Northrop Grumman Corporation")).toBe("northrop grumman");
    expect(normalizeCompanyName("The Trade Desk")).toBe(normalizeCompanyName("Trade Desk"));
    expect(normalizeCompanyName("Company")).toBe("company");
    expect(normalizeCompanyName("Café Labs LLC")).toBe("cafe labs");
    expect(normalizeCompanyName("Vandelay")).not.toBe(normalizeCompanyName("Socrates"));
  });

  it("adds the Workday tenant host of a Workday URL, and nothing for other URLs", () => {
    expect(companyIdentities({
      companyName: "NGC",
      urls: ["https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1", null, undefined]
    })).toEqual(["name:ngc", "workday:ngc.wd1.myworkdayjobs.com"]);
    expect(companyIdentities({ companyName: "Vandelay Inc.", urls: ["https://boards.greenhouse.io/vandelay/jobs/1"] }))
      .toEqual(["name:vandelay"]);
  });

  it("matches postings that share a name or a Workday tenant", () => {
    const workday = companyIdentities({ companyName: "NGC", urls: ["https://ngc.wd1.myworkdayjobs.com/External/job/A"] });
    const named = companyIdentities({ companyName: "Northrop Grumman Corp.", urls: ["https://ngc.wd1.myworkdayjobs.com/Careers/job/B"] });
    expect(sharesCompany(workday, named)).toBe(true);
    expect(sharesCompany(["name:vandelay"], companyIdentities({ companyName: "Vandelay, Inc.", urls: [] }))).toBe(true);
    expect(sharesCompany(["name:vandelay"], ["name:northstar systems"])).toBe(false);
  });
});

describe("company cap", () => {
  it("reads INTERNSHIP_AGENT_COMPANY_CAP as a whole number from 1 to 20", () => {
    expect(companyCapSetting({})).toBe(null);
    expect(companyCapSetting({ INTERNSHIP_AGENT_COMPANY_CAP: "3" })).toBe(3);
    expect(companyCapSetting({ INTERNSHIP_AGENT_COMPANY_CAP: " 0 " })).toBe(1);
    expect(companyCapSetting({ INTERNSHIP_AGENT_COMPANY_CAP: "99" })).toBe(20);
    expect(companyCapSetting({ INTERNSHIP_AGENT_COMPANY_CAP: "abc" })).toBe(null);
  });

  it("names the company and the count", () => {
    expect(companyCapReason("Vandelay", 2)).toBe("Company cap: already 2 applications to Vandelay.");
    expect(companyCapReason("Vandelay", 1)).toBe("Company cap: already 1 application to Vandelay.");
  });

  it("tells a run the pipeline started from one the candidate started, by the latest start event at or before it", () => {
    const T1 = "2026-11-01T00:00:00.000Z";
    const T2 = "2026-11-02T00:00:00.000Z";
    const T3 = "2026-11-03T00:00:00.000Z";
    const T4 = "2026-11-04T00:00:00.000Z";
    const automatic = "Browser run started automatically from the verified package; your approval is required before submission.";
    const workdayAutomatic = "Workday run started automatically from the verified package; your approval is required before submission.";
    const restart = "Browser run restarted after the previous run failed or was cancelled.";
    expect(runStartedByPipeline(T2, [{ detail: automatic, at: T1 }])).toBe(true);
    expect(runStartedByPipeline(T2, [{ detail: workdayAutomatic, at: T1 }])).toBe(true);
    expect(runStartedByPipeline(T2, [{ detail: "Browser run started from the approved package.", at: T1 }])).toBe(false);
    expect(runStartedByPipeline(T2, [{ detail: "Workday run started from the approved package.", at: T1 }])).toBe(false);
    expect(runStartedByPipeline(T2, [{ detail: restart, at: T1 }])).toBe(false);
    // Nothing recorded, or only a start after the run was created: counted as automatic.
    expect(runStartedByPipeline(T2, [])).toBe(true);
    expect(runStartedByPipeline(T2, [{ detail: "Browser run started from the approved package.", at: T3 }])).toBe(true);
    // The latest start at or before the run decides.
    const events = [{ detail: automatic, at: T1 }, { detail: restart, at: T3 }];
    expect(runStartedByPipeline(T4, events)).toBe(false);
    expect(runStartedByPipeline(T2, events)).toBe(true);
    // Other details are not run starts.
    expect(runStartedByPipeline(T2, [
      { detail: "Submission approved automatically by your auto-submit policy: fit 86.", at: T1 },
      { detail: null, at: T1 }
    ])).toBe(true);
    expect(runStartedByPipeline(T2, [
      { detail: "Browser run started from the approved package.", at: T1 },
      { detail: "Submission approved automatically by your auto-submit policy: fit 86.", at: T1 }
    ])).toBe(false);
  });
});

describe("one graduation profile per company", () => {
  it("keeps the earliest submitted profile, else the earliest run's", () => {
    expect(pinnedProfile([
      { profile: "transcript", submitted: false, at: "2026-11-01T00:00:00.000Z" },
      { profile: "default", submitted: true, at: "2026-11-02T00:00:00.000Z" },
      { profile: "transcript", submitted: true, at: "2026-11-03T00:00:00.000Z" }
    ])).toBe("default");
    expect(pinnedProfile([
      { profile: "default", submitted: false, at: "2026-11-02T00:00:00.000Z" },
      { profile: "transcript", submitted: false, at: "2026-11-01T00:00:00.000Z" }
    ])).toBe("transcript");
    expect(pinnedProfile([])).toBe(null);
  });

  it("reads a run's profile from its record, else from its decisions and channel", () => {
    const upload = { basis: { kind: "candidate_document" } };
    const fill = { basis: { kind: "fact" } };
    expect(profileOfRun({ applicationProfile: "default", decisions: [upload] }, "HANDSHAKE_INTERNAL")).toBe("default");
    expect(profileOfRun({ applicationProfile: "transcript", decisions: [] }, "EXTERNAL_ATS")).toBe("transcript");
    expect(profileOfRun({ applicationProfile: null, decisions: [fill, upload] }, "EXTERNAL_ATS")).toBe("transcript");
    expect(profileOfRun({ decisions: [] }, "HANDSHAKE_INTERNAL")).toBe("transcript");
    expect(profileOfRun({ decisions: [fill, { basis: null }] }, "UNKNOWN")).toBe("default");
  });
});
