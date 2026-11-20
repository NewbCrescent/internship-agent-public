import { describe, expect, it } from "vitest";
import { canonicalGitHubJobListUrl, discoveryBudget, discoveryListFilter, fetchGitHubJobList, parseGitHubJobListUrl, plainText, postingLinkKey, fetchEmployerPublication } from "@internship-agent/agent";
import { extractDeterministically, normalizePostingText } from "@internship-agent/jobs";

const description = [
  "We build reliable developer infrastructure for teams across the United States.",
  "Requirements: current enrollment in a computer science degree program.",
  "Experience with TypeScript and Python, careful testing, and clear technical communication.",
  "The internship includes mentorship and production software development."
].join(" ");

const githubSources = [
  {
    repo: "SimplifyJobs/Summer2027-Internships",
    file: "README.md",
    index: '<tr><td><strong>Aurora Labs</strong></td><td>Software Engineering Intern</td><td>Remote</td><td><a href="https://job-boards.greenhouse.io/aurora/jobs/123">Apply</a></td><td>0d</td></tr>',
    board: "https://boards-api.greenhouse.io/v1/boards/aurora/jobs/123?content=true",
    response: { title: "Software Engineering Intern", absolute_url: "https://job-boards.greenhouse.io/aurora/jobs/123", content: "<p>" + description + "</p>", location: { name: "Seattle, WA" } },
    company: "Aurora Labs"
  },
  {
    repo: "vanshb03/Summer2027-Internships",
    file: ".github/scripts/listings.json",
    index: JSON.stringify([
      { company_name: "Inactive Co", title: "Software Intern", url: "https://jobs.lever.co/inactive/1", active: false, date_posted: 2 },
      { company_name: "Beacon Systems", title: "Software Intern", url: "https://jobs.lever.co/beacon/123", active: true, is_visible: true, date_posted: 1 }
    ]),
    board: "https://api.lever.co/v0/postings/beacon/123",
    response: {
      text: "Software Intern", hostedUrl: "https://jobs.lever.co/beacon/123",
      descriptionPlain: description, categories: { location: "Boston, MA" },
      lists: [{ text: "Preferred", content: "<ul><li>Python experience</li></ul>" }]
    },
    company: "Beacon Systems"
  },
  {
    repo: "speedyapply/2027-AI-College-Jobs",
    file: "README.md",
    index: [
      "| Company | Position | Location | Salary | Posting | Age |",
      "| --- | --- | --- | --- | --- | --- |",
      '| <a href="https://example.test">Cedar AI</a> | AI Intern | SF | $50/hr | <a href="https://jobs.ashbyhq.com/cedar/123">Apply</a> | 1d |',
      '| New Grad Co | AI Engineer New Grad | SF | $60/hr | <a href="https://jobs.ashbyhq.com/grad/456">Apply</a> | 1d |'
    ].join("\n"),
    board: "https://api.ashbyhq.com/posting-api/job-board/cedar",
    response: { jobs: [{ id: "123", title: "AI Intern", jobUrl: "https://jobs.ashbyhq.com/cedar/123", isListed: true, descriptionPlain: description, location: "San Francisco" }] },
    company: "Cedar AI"
  },
  {
    repo: "northwesternfintech/2027QuantInternships",
    file: "README.md",
    index: "## Delta Trading\n|Role|Links|\n|---|---|\n|QR|[✅](https://job-boards.greenhouse.io/delta/jobs/123)|",
    board: "https://boards-api.greenhouse.io/v1/boards/delta/jobs/123?content=true",
    response: { title: "Quantitative Research Intern", absolute_url: "https://job-boards.greenhouse.io/delta/jobs/123", content: description },
    company: "Delta Trading"
  },
  {
    repo: "speedyapply/2027-SWE-College-Jobs",
    file: "README.md",
    index: '| <a href="https://example.test">Echo</a> | SWE Intern | NYC | $50/hr | <a href="https://job-boards.greenhouse.io/echo/jobs/123">Apply</a> | 1d |',
    board: "https://boards-api.greenhouse.io/v1/boards/echo/jobs/123?content=true",
    response: { title: "SWE Intern", absolute_url: "https://job-boards.greenhouse.io/echo/jobs/123", content: description },
    company: "Echo"
  }
];

describe("selected GitHub internship lists", () => {
  it("preserves encoded HTML list items as grounded requirement bullets", () => {
    const markup = "&lt;p&gt;Requirements:&lt;/p&gt;&lt;ul&gt;" +
      "&lt;li&gt;&lt;p&gt;Must be working towards a PhD in computer science.&lt;/p&gt;&lt;/li&gt;" +
      "&lt;li&gt;Experience with Python is preferred.&lt;/li&gt;&lt;/ul&gt;";
    const normalized = normalizePostingText(plainText(markup));
    expect(normalized).toContain("\n- Must be working towards a PhD in computer science.");
    expect(normalized).toContain("\n- Experience with Python is preferred.");
    const requirements = extractDeterministically(normalized).requirements;
    expect(requirements).toHaveLength(2);
    expect(requirements[0]).toMatchObject({ category: "HARD", subject: "DEGREE" });
    expect(requirements[1]).toMatchObject({ category: "PREFERRED", subject: "SKILL" });
  });

  it("accepts only the five selected repository roots", () => {
    for (const source of githubSources) {
      expect(parseGitHubJobListUrl("https://github.com/" + source.repo)).toBeTruthy();
      expect(canonicalGitHubJobListUrl("https://github.com/" + source.repo + "/")).toBe("https://github.com/" + source.repo);
    }
    for (const url of [
      "https://github.com/other/jobs", "https://github.com/SimplifyJobs/Summer2027-Internships/issues",
      "https://github.com/SimplifyJobs/Summer2027-Internships?tab=readme",
      "https://github.com.evil.test/SimplifyJobs/Summer2027-Internships",
      "http://github.com/SimplifyJobs/Summer2027-Internships"
    ]) expect(() => parseGitHubJobListUrl(url)).toThrow();
  });

  it.each(githubSources)("resolves full public postings from $repo", async (source) => {
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList({ url: "https://github.com/" + source.repo }, async (url, init) => {
      requests.push(url);
      expect(init?.redirect).toBe("error");
      if (url.includes("/HEAD/" + source.file)) return new Response(source.index);
      if (url.endsWith("/HEAD/INTERN_INTL.md")) return new Response("");
      if (url === source.board) return new Response(JSON.stringify(source.response));
      throw new Error("Unexpected network request: " + url);
    }, { delayMs: 0 });
    expect(fetched.items).toHaveLength(1);
    expect(fetched.items[0]).toMatchObject({ companyName: source.company });
    expect(fetched.items[0]?.text).toContain("Requirements");
    expect(fetched.items[0]?.sourceUrl).toMatch(/^https:\/\//);
    expect(requests).toContain(source.board);
  });

  it("reports unsupported links without inventing posting descriptions", async () => {
    const index = [
      '| Cedar AI | AI Intern | SF | $50/hr | <a href="https://example.test/apply/1">Apply</a> | 1d |',
      '| Cedar AI | AI Intern | SF | $50/hr | <a href="https://job-boards.greenhouse.io/cedar/jobs/123">Apply</a> | 1d |'
    ].join("\n");
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-AI-College-Jobs" },
      async (url) => url.includes("raw.githubusercontent.com")
        ? new Response(url.endsWith("/README.md") ? index : "")
        : new Response(JSON.stringify({ title: "AI Intern", absolute_url: "https://job-boards.greenhouse.io/cedar/jobs/123", content: description })),
      { delayMs: 0 }
    );
    expect(fetched.items).toHaveLength(1);
    expect(fetched.notes.join(" ")).toContain("1 link needs manual review");
    expect(fetched.items[0]?.text).not.toContain("example.test");
  });

  it("resolves Workday career-site links through the public job endpoint", async () => {
    const index = [
      '| Fjord | SWE Intern | NYC | $50/hr | <a href="https://fjord.wd5.myworkdayjobs.com/en-US/External/job/New-York/SWE-Intern_JR1?utm_source=Simplify">Apply</a> | 1d |',
      '| Fjord | Data Intern | NYC | $50/hr | <a href="https://fjord.wd5.myworkdayjobs.com/External/job/New-York/Data-Intern_JR2">Apply</a> | 1d |',
      '| Fjord | Closed Intern | NYC | $50/hr | <a href="https://fjord.wd5.myworkdayjobs.com/External/job/New-York/Closed-Intern_JR3">Apply</a> | 1d |',
      '| Fjord | Lookalike Intern | NYC | $50/hr | <a href="https://fjord.wd5.myworkdayjobs.com.example.test/External/job/X/Y_JR4">Apply</a> | 1d |'
    ].join("\n");
    const endpoint = "https://fjord.wd5.myworkdayjobs.com/wday/cxs/fjord/External/job/New-York/";
    const posting = (title: string, extra: object = {}) => new Response(JSON.stringify({
      jobPostingInfo: { title, location: "New York, NY", jobDescription: "<p>" + description + "</p><ul><li>Python experience</li></ul>", ...extra }
    }));
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        requests.push(url);
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        if (url === endpoint + "SWE-Intern_JR1") return posting("SWE Intern", { externalUrl: "https://fjord.wd5.myworkdayjobs.com/External/job/New-York/SWE-Intern_JR1" });
        if (url === endpoint + "Data-Intern_JR2") return posting("Data Intern", { externalUrl: "https://elsewhere.example.test/job" });
        if (url === endpoint + "Closed-Intern_JR3") return posting("Closed Intern", { canApply: false });
        throw new Error("Unexpected network request: " + url);
      },
      { delayMs: 0 }
    );
    expect(fetched.items.map((item) => item.title)).toEqual(["SWE Intern", "Data Intern"]);
    expect(fetched.items[0]?.sourceUrl).toBe("https://fjord.wd5.myworkdayjobs.com/External/job/New-York/SWE-Intern_JR1");
    // A foreign externalUrl never replaces the Workday posting's own address.
    expect(fetched.items[1]?.sourceUrl).toBe("https://fjord.wd5.myworkdayjobs.com/External/job/New-York/Data-Intern_JR2");
    expect(fetched.items[0]?.text).toContain("Location: New York, NY");
    expect(fetched.items[0]?.text).toContain("\n- Python experience");
    expect(fetched.notes.join(" ")).toContain("1 link needs manual review");
    expect(fetched.notes.join(" ")).toContain("1 public posting was unavailable");
    expect(requests.some((url) => url.includes("example.test"))).toBe(false);
  });

  it("joins a Workday posting's country to its single location, so a Milan posting reads as Italy", async () => {
    const index = [
      '| Fjord | Milan Intern | Milan | $50/hr | <a href="https://fjord.wd3.myworkdayjobs.com/External/job/Milan/Milan-Intern_JR1">Apply</a> | 1d |',
      '| Fjord | Multi Intern | Many | $50/hr | <a href="https://fjord.wd3.myworkdayjobs.com/External/job/Milan/Multi-Intern_JR2">Apply</a> | 1d |',
      '| Fjord | Santa Clara Intern | CA | $50/hr | <a href="https://fjord.wd3.myworkdayjobs.com/External/job/Milan/Santa-Clara-Intern_JR3">Apply</a> | 1d |'
    ].join("\n");
    const endpoint = "https://fjord.wd3.myworkdayjobs.com/wday/cxs/fjord/External/job/Milan/";
    const posting = (title: string, extra: object) => new Response(JSON.stringify({
      jobPostingInfo: { title, jobDescription: "<p>" + description + "</p>", ...extra }
    }));
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        if (url === endpoint + "Milan-Intern_JR1") return posting("Milan Intern", { location: "Milan", country: { descriptor: "Italy" } });
        if (url === endpoint + "Multi-Intern_JR2") return posting("Multi Intern", { location: "2 Locations", country: { descriptor: "Italy" } });
        if (url === endpoint + "Santa-Clara-Intern_JR3") {
          return posting("Santa Clara Intern", { location: "US, CA, Santa Clara", jobRequisitionLocation: { country: { descriptor: "United States of America" } } });
        }
        throw new Error("Unexpected network request: " + url);
      },
      { delayMs: 0 }
    );
    const [milan, multi, santaClara] = fetched.items;
    expect(milan?.text.startsWith("Location: Milan, Italy\n")).toBe(true);
    const countries = (text: string | undefined) => extractDeterministically(normalizePostingText(text ?? "")).locations.map((location) => location.countryCode);
    expect(countries(milan?.text)).toContain("IT");
    // "2 Locations" names no place, so the list's own column is added (labelled), never Italy.
    expect(multi?.text.startsWith("Job list location: Many\n\nLocation: 2 Locations\n")).toBe(true);
    expect(countries(multi?.text)).not.toContain("IT");
    expect(countries(santaClara?.text)).toContain("US");
    expect(countries(santaClara?.text)).not.toContain("IT");
  });

  it("treats a malformed Workday payload as unavailable", async () => {
    const index = '| Fjord | SWE Intern | NYC | $50/hr | <a href="https://fjord.wd1.myworkdayjobs.com/External/job/NYC/SWE-Intern_JR1">Apply</a> | 1d |';
    await expect(fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => url.includes("raw.githubusercontent.com")
        ? new Response(url.endsWith("/README.md") ? index : "")
        : new Response(JSON.stringify({ jobPostingInfo: { description: "missing title" } })),
      { delayMs: 0 }
    )).rejects.toThrow("1 public posting was unavailable");
  });

  it("resolves SmartRecruiters links through the public posting API", async () => {
    const index = [
      '| Gale | SWE Intern | Remote | $50/hr | <a href="https://jobs.smartrecruiters.com/GaleInc/744000111?utm_source=Simplify">Apply</a> | 1d |',
      '| Gale | Data Intern | Remote | $50/hr | <a href="https://jobs.smartrecruiters.com/GaleInc/744000222-data-intern">Apply</a> | 1d |',
      '| Gale | Closed Intern | Remote | $50/hr | <a href="https://jobs.smartrecruiters.com/GaleInc/744000333">Apply</a> | 1d |',
      '| Gale | Lookalike Intern | Remote | $50/hr | <a href="https://jobs.smartrecruiters.com.example.test/GaleInc/744000444">Apply</a> | 1d |'
    ].join("\n");
    const endpoint = "https://api.smartrecruiters.com/v1/companies/GaleInc/postings/";
    const posting = (name: string, extra: object = {}) => new Response(JSON.stringify({
      name, active: true, location: { fullLocation: "Des Moines, IA, United States" },
      jobAd: { sections: {
        companyDescription: { title: "Company Description", text: "<p>Company boilerplate that is not a requirement.</p>" },
        jobDescription: { title: "Job Description", text: "<p>" + description + "</p>" },
        qualifications: { title: "Qualifications", text: "<ul><li>Python experience</li></ul>" }
      } },
      ...extra
    }));
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        requests.push(url);
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        if (url === endpoint + "744000111") return posting("SWE Intern", { postingUrl: "https://jobs.smartrecruiters.com/GaleInc/744000111-swe-intern" });
        if (url === endpoint + "744000222") return posting("Data Intern", { postingUrl: "https://elsewhere.example.test/job" });
        if (url === endpoint + "744000333") return posting("Closed Intern", { active: false });
        throw new Error("Unexpected network request: " + url);
      },
      { delayMs: 0 }
    );
    expect(fetched.items.map((item) => item.title)).toEqual(["SWE Intern", "Data Intern"]);
    expect(fetched.items[0]?.sourceUrl).toBe("https://jobs.smartrecruiters.com/GaleInc/744000111-swe-intern");
    expect(fetched.items[1]?.sourceUrl).toBe("https://jobs.smartrecruiters.com/GaleInc/744000222");
    expect(fetched.items[0]?.text).toContain("Location: Des Moines, IA, United States");
    expect(fetched.items[0]?.text).toContain("Qualifications:\n- Python experience");
    expect(fetched.items[0]?.text).not.toContain("Company boilerplate");
    expect(fetched.notes.join(" ")).toContain("1 link needs manual review");
    expect(fetched.notes.join(" ")).toContain("1 public posting was unavailable");
    expect(requests.some((url) => url.includes("example.test"))).toBe(false);
  });

  it("resolves Oracle Cloud links from external fields only", async () => {
    const base = "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/";
    const index = [
      '| Harbor | SWE Intern | SLC | $50/hr | <a href="' + base + '101?utm_source=Simplify">Apply</a> | 1d |',
      '| Harbor | Expired Intern | SLC | $50/hr | <a href="' + base + '102">Apply</a> | 1d |',
      '| Harbor | Missing Intern | SLC | $50/hr | <a href="' + base + '103">Apply</a> | 1d |',
      '| Harbor | Lookalike Intern | SLC | $50/hr | <a href="https://egug.fa.us2.oraclecloud.com.example.test/hcmUI/CandidateExperience/en/sites/CX_1/job/104">Apply</a> | 1d |'
    ].join("\n");
    const endpoint = (id: string) => "https://egug.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails" +
      "?onlyData=true&finder=ById;Id=%22" + id + "%22,siteNumber=CX_1";
    const requisition = (title: string, endDate: string) => new Response(JSON.stringify({ items: [{
      Title: title, PrimaryLocation: "Salt Lake City, UT, United States", ExternalPostedEndDate: endDate,
      ExternalDescriptionStr: "<p>" + description + "</p>",
      ExternalResponsibilitiesStr: "<ul><li>Build internal tools</li></ul>",
      ExternalQualificationsStr: "<ul><li>Python experience</li></ul>",
      InternalQualificationsStr: "<ul><li>Employee-only referral note</li></ul>"
    }] }));
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        if (url === endpoint("101")) return requisition("SWE Intern", "2999-01-01T00:00:00+00:00");
        if (url === endpoint("102")) return requisition("Expired Intern", "2000-01-01T00:00:00+00:00");
        if (url === endpoint("103")) return new Response(JSON.stringify({ items: [] }));
        throw new Error("Unexpected network request: " + url);
      },
      { delayMs: 0 }
    );
    expect(fetched.items.map((item) => item.title)).toEqual(["SWE Intern"]);
    expect(fetched.items[0]?.sourceUrl).toBe(base + "101");
    expect(fetched.items[0]?.text).toContain("Location: Salt Lake City, UT, United States");
    expect(fetched.items[0]?.text).toContain("Responsibilities:\n- Build internal tools");
    expect(fetched.items[0]?.text).toContain("Qualifications:\n- Python experience");
    expect(fetched.items[0]?.text).not.toContain("Employee-only");
    expect(fetched.notes.join(" ")).toContain("1 link needs manual review");
    expect(fetched.notes.join(" ")).toContain("2 public postings were unavailable");
  });

  it("gives a listing link and its stored posting URL the same key", () => {
    const pairs: Array<[string, string]> = [
      ["https://job-boards.greenhouse.io/figma/jobs/6143238004?utm_source=Simplify", "https://boards.greenhouse.io/figma/jobs/6143238004?gh_jid=6143238004"],
      ["https://job-boards.greenhouse.io/figma/jobs/6143238004", "https://www.figma.example.test/careers/job?gh_jid=6143238004"],
      ["https://jobs.lever.co/Beacon/ABC-123/apply", "https://jobs.lever.co/beacon/abc-123"],
      ["https://jobs.ashbyhq.com/cedar/AB12?utm_source=Simplify", "https://jobs.ashbyhq.com/cedar/ab12"],
      ["https://fjord.wd5.myworkdayjobs.com/en-US/External/job/New-York/SWE-Intern_JR1?utm_source=Simplify", "https://fjord.wd5.myworkdayjobs.com/External/job/New-York/SWE-Intern_JR1"],
      ["https://jobs.smartrecruiters.com/GaleInc/744000111?utm_source=Simplify", "https://jobs.smartrecruiters.com/GaleInc/744000111-swe-intern"],
      ["https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/101?utm_source=Simplify", "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/101"]
    ];
    for (const [listing, stored] of pairs) {
      expect(postingLinkKey(listing)).not.toBeNull();
      expect(postingLinkKey(listing)).toBe(postingLinkKey(stored));
    }
    expect(postingLinkKey("https://jobs.lever.co/beacon/abc-123")).not.toBe(postingLinkKey("https://jobs.lever.co/other/abc-123"));
    expect(postingLinkKey("https://example.test/apply/1")).toBeNull();
    expect(postingLinkKey("manual-batch://0123456789abcdef")).toBeNull();
  });

  it("skips known links before fetching and applies the scan cap to new links only", async () => {
    const link = (id: number) => "https://job-boards.greenhouse.io/aurora/jobs/" + id;
    const index = Array.from({ length: 101 }, (_, n) =>
      '| Aurora | SWE Intern ' + n + ' | Remote | $50/hr | <a href="' + link(1000 + n) + '?utm_source=Simplify">Apply</a> | 1d |').join("\n");
    const knownLinkKeys = new Set(Array.from({ length: 100 }, (_, n) => postingLinkKey(link(1000 + n))!));
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        requests.push(url);
        return new Response(JSON.stringify({ title: "SWE Intern 100", absolute_url: link(1100), content: description }));
      },
      { delayMs: 0, knownLinkKeys }
    );
    // The only unknown link sits past the first 100 rows and is still reached.
    expect(requests).toEqual(["https://boards-api.greenhouse.io/v1/boards/aurora/jobs/1100?content=true"]);
    expect(fetched.items.map((item) => item.title)).toEqual(["SWE Intern 100"]);
    expect(fetched.notes[0]).toBe("100 listed links were already in the workspace and not fetched again.");
  });

  it("returns an empty result when every listed link is already known", async () => {
    const index = '| Aurora | SWE Intern | Remote | $50/hr | <a href="https://job-boards.greenhouse.io/aurora/jobs/123">Apply</a> | 1d |';
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        throw new Error("Known links must not be fetched: " + url);
      },
      { delayMs: 0, knownLinkKeys: new Set(["greenhouse:123"]) }
    );
    expect(fetched.items).toEqual([]);
    expect(fetched.notes[0]).toBe("1 listed link was already in the workspace and not fetched again.");
  });

  it("scales the per-check budget from the configured posting limit", () => {
    expect(discoveryBudget({})).toEqual({ maxPostings: 100, maxListingsScanned: 500, maxPostingRequests: 150, maxFetchTimeMs: 450_000 });
    expect(discoveryBudget({ INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS: "20" }))
      .toEqual({ maxPostings: 20, maxListingsScanned: 100, maxPostingRequests: 30, maxFetchTimeMs: 90_000 });
    expect(discoveryBudget({ INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS: "500" }).maxPostings).toBe(100);
    expect(discoveryBudget({ INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS: "0" }).maxPostings).toBe(1);
    for (const invalid of ["", " ", "ten", "-5", "2.5"]) {
      expect(discoveryBudget({ INTERNSHIP_AGENT_DISCOVERY_MAX_POSTINGS: invalid }).maxPostings).toBe(100);
    }
  });

  it("resolves more than the former 20-posting cap in one check", async () => {
    const link = (id: number) => "https://job-boards.greenhouse.io/aurora/jobs/" + id;
    const index = Array.from({ length: 30 }, (_, n) =>
      '| Aurora | SWE Intern ' + n + ' | Remote | $50/hr | <a href="' + link(2000 + n) + '">Apply</a> | 1d |').join("\n");
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? index : "");
        const id = /jobs\/(\d+)/.exec(url)![1]!;
        return new Response(JSON.stringify({ title: "SWE Intern " + id, absolute_url: link(Number(id)), content: description }));
      },
      { delayMs: 0 }
    );
    expect(fetched.items).toHaveLength(30);
  });

  it("refuses oversized index responses before parsing", async () => {
    await expect(fetchGitHubJobList(
      { url: "https://github.com/northwesternfintech/2027QuantInternships" },
      async () => new Response("x".repeat(5_000_001)),
      { delayMs: 0 }
    )).rejects.toThrow("too large");
  });
});

describe("employer publication fields", () => {
  it("uses Greenhouse first_published rather than updated_at", async () => {
    const source = githubSources[0]!;
    const fetcher = async () => new Response(JSON.stringify({ ...source.response, first_published: "2026-09-01T10:00:00-07:00", updated_at: "2026-10-06T12:00:00Z" }));
    expect(await fetchEmployerPublication("https://job-boards.greenhouse.io/aurora/jobs/123", fetcher)).toMatchObject({ postedAt: "2026-09-01T17:00:00.000Z", field: "first_published" });
  });
  it("preserves Ashby publication dates during discovery", async () => {
    const source = githubSources[2]!;
    const fetcher = async (url: string) => new Response(url.includes("/HEAD/") ? (url.endsWith("INTERN_INTL.md") ? "" : source.index) : JSON.stringify({ jobs: [{ id: "123", title: "AI Intern", jobUrl: "https://jobs.ashbyhq.com/cedar/123", isListed: true, descriptionPlain: description, publishedAt: "2026-09-01T12:00:00Z" }] }));
    const result = await fetchGitHubJobList({ url: "https://github.com/" + source.repo }, fetcher, { delayMs: 0 });
    expect(result.items[0].publication).toMatchObject({ postedAt: "2026-09-01T12:00:00.000Z", field: "publishedAt" });
  });
  it("leaves missing, invalid, future, and Lever creation dates unknown", async () => {
    for (const first_published of [undefined, "yesterday", "2099-01-01T00:00:00Z"]) {
      expect(await fetchEmployerPublication("https://job-boards.greenhouse.io/aurora/jobs/123", async () => new Response(JSON.stringify({ ...githubSources[0].response, first_published, updated_at: "2026-10-06T12:00:00Z" })))).toBeNull();
    }
    let requested = false;
    expect(await fetchEmployerPublication("https://jobs.lever.co/beacon/123", async () => { requested = true; return new Response("{}"); })).toBeNull();
    expect(requested).toBe(false);
  });
  it("uses Workday's startDate, retaining its date-only precision", async () => {
    expect(await fetchEmployerPublication("https://fixture.wd1.myworkdayjobs.com/External/job/City/Intern_123", async () => new Response(JSON.stringify({ jobPostingInfo: { title: "Software Intern", jobDescription: description, startDate: "2026-09-30", postedOn: "Posted Today" } })))).toMatchObject({ postedAt: "2026-09-30T00:00:00.000Z", field: "startDate", precision: "date" });
  });
});

describe("fresh, in-season list rows", () => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const greenhouse = (id: number) => "https://job-boards.greenhouse.io/aurora/jobs/" + id;
  const boardResponse = (url: string) => {
    const id = /jobs\/(\d+)/.exec(url)![1]!;
    return new Response(JSON.stringify({ title: "SWE Intern " + id, absolute_url: greenhouse(Number(id)), content: description }));
  };

  it("reads the age and season settings from the environment", () => {
    expect(discoveryListFilter({})).toEqual({ maxAgeDays: null, season: null });
    expect(discoveryListFilter({ INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS: "3", INTERNSHIP_AGENT_TARGET_TERM: "Summer-2027" }))
      .toEqual({ maxAgeDays: 3, season: "summer" });
    for (const invalid of ["0", "-1", "three", "2.5", ""]) {
      expect(discoveryListFilter({ INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS: invalid }).maxAgeDays).toBeNull();
    }
    expect(discoveryListFilter({ INTERNSHIP_AGENT_DISCOVERY_MAX_AGE_DAYS: "9999" }).maxAgeDays).toBe(365);
    expect(discoveryListFilter({ INTERNSHIP_AGENT_TARGET_TERM: "summer" }).season).toBeNull();
  });

  it("skips rows listed longer ago than the limit, and undated rows, before fetching", async () => {
    const ages = ["0d", "3d", "4d", "1mo", "", "5h", "2w"];
    const index = ages.map((age, n) =>
      '<tr><td>Aurora</td><td>SWE Intern ' + n + '</td><td>Remote</td><td><a href="' + greenhouse(3000 + n) + '">Apply</a></td><td>' + age + '</td></tr>').join("\n");
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/SimplifyJobs/Summer2027-Internships" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(index);
        requests.push(url);
        return boardResponse(url);
      },
      { delayMs: 0, now, filter: { maxAgeDays: 3, season: null } }
    );
    expect(requests.map((url) => /jobs\/(\d+)/.exec(url)![1])).toEqual(["3000", "3001", "3005"]);
    expect(fetched.notes).toContain("4 listed rows were older than 3 days or undated and skipped.");
  });

  it("finds nothing new without failing when every row is stale", async () => {
    const index = '<tr><td>Aurora</td><td>SWE Intern</td><td>Remote</td><td><a href="' + greenhouse(1) + '">Apply</a></td><td>9d</td></tr>';
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/SimplifyJobs/Summer2027-Internships" },
      async (url) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(index);
        throw new Error("Stale rows must not be fetched: " + url);
      },
      { delayMs: 0, now, filter: { maxAgeDays: 3, season: null } }
    );
    expect(fetched.items).toEqual([]);
  });

  it("follows Vansh short links one hop, skips other seasons, and labels the list's location", async () => {
    const seconds = (daysAgo: number) => Math.floor((now - daysAgo * 86_400_000) / 1000);
    const index = JSON.stringify([
      { company_name: "Beacon", title: "Software Intern", url: "https://go.vansh.nyc/A1", active: true, date_posted: seconds(1), locations: ["Austin, TX"], season: "Summer" },
      { company_name: "Beacon", title: "Software Co-op Intern", url: "https://go.vansh.nyc/B2", active: true, date_posted: seconds(1), season: "Winter" },
      { company_name: "Beacon", title: "Old Software Intern", url: "https://go.vansh.nyc/C3", active: true, date_posted: seconds(10), season: "Summer" },
      { company_name: "Known", title: "Known Software Intern", url: "https://go.vansh.nyc/D4", active: true, date_posted: seconds(0), season: "Summer" }
    ]);
    const requests: string[] = [];
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/vanshb03/Summer2027-Internships" },
      async (url, init) => {
        if (url.includes("raw.githubusercontent.com")) return new Response(index);
        requests.push(url);
        if (url.startsWith("https://go.vansh.nyc/")) {
          expect(init?.redirect).toBe("manual");
          const target = url.endsWith("A1") ? greenhouse(4001) : greenhouse(4004);
          return new Response(null, { status: 302, headers: { location: target } });
        }
        return boardResponse(url);
      },
      { delayMs: 0, now, filter: { maxAgeDays: 3, season: "summer" }, knownLinkKeys: new Set(["greenhouse:4004"]) }
    );
    // Short links resolve first; the known posting behind D4 is never fetched.
    expect(requests).toEqual(["https://go.vansh.nyc/D4", "https://go.vansh.nyc/A1", "https://boards-api.greenhouse.io/v1/boards/aurora/jobs/4001?content=true"]);
    expect(fetched.items).toHaveLength(1);
    expect(fetched.items[0]!.text.startsWith("Job list location: Austin, TX\n\n")).toBe(true);
    expect(fetched.notes).toContain("1 listed row was for another season and skipped.");
    expect(fetched.notes).toContain("1 listed row was older than 3 days or undated and skipped.");
    const extracted = extractDeterministically(normalizePostingText(fetched.items[0]!.text));
    expect(extracted.locations.map((location) => location.countryCode)).toContain("US");
  });

  it("keeps the board's own location over the list's column", async () => {
    const index = '<tr><td>Aurora</td><td>SWE Intern</td><td>Paris, France</td><td><a href="https://job-boards.greenhouse.io/aurora/jobs/123">Apply</a></td><td>0d</td></tr>';
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/SimplifyJobs/Summer2027-Internships" },
      async (url) => url.includes("raw.githubusercontent.com") ? new Response(index)
        : new Response(JSON.stringify({ title: "SWE Intern", absolute_url: "https://job-boards.greenhouse.io/aurora/jobs/123", content: description, location: { name: "Seattle, WA" } })),
      { delayMs: 0, now, filter: { maxAgeDays: 3, season: null } }
    );
    expect(fetched.items[0]!.text.startsWith("Location: Seattle, WA")).toBe(true);
    expect(fetched.items[0]!.text).not.toContain("Job list location");
  });

  it("adds the list's column when the board's own location names no place", async () => {
    const index = '<tr><td>Aurora</td><td>SWE Intern</td><td>Johnston, IA</td><td><a href="https://job-boards.greenhouse.io/aurora/jobs/123">Apply</a></td><td>0d</td></tr>';
    const fetched = await fetchGitHubJobList(
      { url: "https://github.com/SimplifyJobs/Summer2027-Internships" },
      async (url) => url.includes("raw.githubusercontent.com") ? new Response(index)
        : new Response(JSON.stringify({ title: "SWE Intern", absolute_url: "https://job-boards.greenhouse.io/aurora/jobs/123", content: description, location: { name: "Hybrid" } })),
      { delayMs: 0, now, filter: { maxAgeDays: 3, season: null } }
    );
    expect(fetched.items[0]!.text.startsWith("Job list location: Johnston, IA\n\nLocation: Hybrid\n")).toBe(true);
    expect(extractDeterministically(normalizePostingText(fetched.items[0]!.text)).locations.map((location) => location.countryCode)).toEqual(["US"]);
  });
});

describe("structured ATS location fields", () => {
  const countries = (text: string | undefined) =>
    [...new Set(extractDeterministically(normalizePostingText(text ?? "")).locations.map((location) => location.countryCode))];
  /** One speedyapply row per posting URL; the list's own location column says nothing ("—"). */
  const listOf = (urls: string[]) => urls.map((url, index) => `| Fixture ${index} | Software Intern | — | $50/hr | <a href="${url}">Apply</a> | 1d |`).join("\n");
  const fetchAll = async (urls: string[], answer: (url: string) => unknown) => (await fetchGitHubJobList(
    { url: "https://github.com/speedyapply/2027-SWE-College-Jobs" },
    async (url) => {
      if (url.includes("raw.githubusercontent.com")) return new Response(url.endsWith("/README.md") ? listOf(urls) : "");
      const body = answer(url);
      if (body === undefined) throw new Error("Unexpected network request: " + url);
      return new Response(JSON.stringify(body));
    },
    { delayMs: 0 }
  )).items;

  it("reads Ashby's postal address: a Berlin posting is Germany, South San Francisco and a Hybrid Iowa office are the US", async () => {
    const ashby = (id: string, location: string, locality: string, region: string, country: string) => ({
      id, title: "Software Intern", jobUrl: `https://jobs.ashbyhq.com/fixtureboard/${id}`, isListed: true, descriptionPlain: description, location,
      address: { postalAddress: { addressLocality: locality, addressRegion: region, addressCountry: country } }
    });
    const jobs = [
      ashby("a1", "Berlin", "Berlin", "Berlin", "Germany"),
      ashby("a2", "South San Francisco", "South San Francisco", "California", "United States"),
      { ...ashby("a3", "Hybrid", "Johnston", "Iowa", "United States"), secondaryLocations: [{ location: "Remote", address: null }] }
    ];
    const items = await fetchAll(jobs.map((job) => job.jobUrl), (url) => url === "https://api.ashbyhq.com/posting-api/job-board/fixtureboard" ? { jobs } : undefined);
    expect(items.map((item) => item.text.split("\n", 1)[0])).toEqual([
      "Location: Berlin, Germany",
      "Location: South San Francisco, California, United States",
      "Location: Johnston, Iowa, United States"
    ]);
    expect(items.map((item) => countries(item.text))).toEqual([["DE"], ["US"], ["US"]]);
  });

  it("names Lever's posting country, so Seoul is South Korea and Paris is France", async () => {
    const lever = (slug: string, location: string, country: string) => ({
      text: "Software Engineer Intern", hostedUrl: `https://jobs.lever.co/${slug}/00000000-0000-4000-8000-000000000001`,
      descriptionPlain: description, country, categories: { location, allLocations: [location] }
    });
    const items = await fetchAll(
      ["https://jobs.lever.co/fixturefashion/00000000-0000-4000-8000-000000000001", "https://jobs.lever.co/fixturecloud/00000000-0000-4000-8000-000000000001"],
      (url) => url.startsWith("https://api.lever.co/v0/postings/fixturefashion/") ? lever("fixturefashion", "Seoul", "KR")
        : url.startsWith("https://api.lever.co/v0/postings/fixturecloud/") ? lever("fixturecloud", "Paris", "FR") : undefined
    );
    expect(items.map((item) => item.text.split("\n", 1)[0])).toEqual(["Location: Seoul, South Korea", "Location: Paris, France"]);
    expect(items.map((item) => countries(item.text))).toEqual([["KR"], ["FR"]]);
  });

  it("adds Greenhouse's office line when the offices say more than the location", async () => {
    const items = await fetchAll(["https://job-boards.greenhouse.io/fixtureoffice/jobs/77"], (url) => url.startsWith("https://boards-api.greenhouse.io/v1/boards/fixtureoffice/jobs/77")
      ? { title: "SWE Intern", absolute_url: "https://job-boards.greenhouse.io/fixtureoffice/jobs/77", content: description, location: { name: "HQ" }, offices: [{ id: 1, name: "Headquarters", location: "Austin, Texas, United States" }] }
      : undefined);
    expect(items[0]!.text.startsWith("Location: HQ\nOffice: Austin, Texas, United States\n\n")).toBe(true);
    expect(countries(items[0]!.text)).toEqual(["US"]);
  });
});
