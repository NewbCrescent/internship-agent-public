import { describe, expect, it } from "vitest";

import type { ResumeEntry } from "@internship-agent/domain";
import {
  buildResumeDocument,
  buildResumeVariant,
  renderResumeDocumentHtml,
  renderResumeDocumentMarkdown,
  renderResumeHtml
} from "@internship-agent/resume";

function entry(
  id: string,
  section: ResumeEntry["section"],
  content: Partial<ResumeEntry["current"]> & { title: string; bullets: string[] },
  reviewStatus: "PENDING" | "APPROVED" = "APPROVED"
): ResumeEntry {
  return {
    id,
    candidateId: "local-candidate",
    section,
    position: 0,
    archivedAt: null,
    createdAt: "2026-09-22T12:00:00.000Z",
    current: {
      id: id.replace(/^.{8}/, "99999999"),
      entryId: id,
      role: null,
      linkLabel: null,
      linkUrl: null,
      location: null,
      dateText: null,
      source: { kind: "user" },
      reviewStatus,
      approvedAt: null,
      createdAt: "2026-09-22T12:00:00.000Z",
      supersededAt: null,
      ...content
    }
  };
}

const PROFILE = {
  fullName: "Jordan Rivera",
  email: "jordan@example.test",
  phone: "555-0100",
  school: "Example State University",
  degree: "B.S. Computer Science, Engineering",
  gpa: "3.800",
  graduationDate: "2028-05-15",
  githubUrl: "https://github.com/example",
  linkedinUrl: "https://www.linkedin.com/in/example/",
  portfolioUrl: "https://www.example.test"
};

const ENTRIES = [
  entry("11111111-1111-4111-8111-111111111111", "experience", {
    title: "Aurora Labs",
    role: "Software Engineering Intern",
    location: "Berkeley, CA",
    dateText: "2026",
    bullets: ["Built ingestion pipelines, increasing reliability by 40%."]
  }),
  entry("22222222-2222-4222-8222-222222222222", "project", {
    title: "Mood Board",
    linkLabel: "mood.example.test",
    linkUrl: "https://mood.example.test",
    location: "Berkeley, CA",
    dateText: "2026",
    bullets: ["Real-time rooms with 20 Hz cursor updates."]
  }),
  entry("33333333-3333-4333-8333-333333333333", "skills", { title: "Languages", bullets: ["Python", "TypeScript"] }),
  entry("44444444-4444-4444-8444-444444444444", "project", { title: "Unreviewed", bullets: ["Pending text."] }, "PENDING")
];

describe("structured resume documents", () => {
  it("prints only the entries chosen for the resume; the rest stay library content", () => {
    const library = ENTRIES.map((item) => (item.section === "project" ? { ...item, onResume: false } : { ...item, onResume: true }));
    const document = buildResumeDocument(PROFILE, library);
    expect(document.projects).toEqual([]);
    expect(document.experience.map((item) => item.title)).toEqual(["Aurora Labs"]);
  });

  it("freezes approved entries and the profile into the candidate's layout", () => {
    const document = buildResumeDocument(PROFILE, ENTRIES);
    expect(document.experience.map((item) => item.title)).toEqual(["Aurora Labs"]);
    expect(document.projects.map((item) => item.title)).toEqual(["Mood Board"]);
    expect(document.skills.map((item) => item.title)).toEqual(["Languages"]);
    expect(document.education).toEqual({
      school: "Example State University",
      degree: "B.S. Computer Science, Engineering",
      gpa: "3.800",
      graduationDate: "2028-05-15"
    });

    const markdown = renderResumeDocumentMarkdown(document);
    expect(markdown).toContain("jordan@example.test • 555-0100 • [GitHub](https://github.com/example) • [LinkedIn](https://www.linkedin.com/in/example/) • [example.test](https://www.example.test)");
    expect(markdown).toContain("- **Example State University** — B.S. Computer Science, Engineering | GPA: 3.800 (Expected May 2028)");
    expect(markdown).toContain("## Professional Experience\n### **Aurora Labs** | Software Engineering Intern — Berkeley, CA 2026\n- Built ingestion pipelines, increasing reliability by 40%.");
    expect(markdown).toContain("### **Mood Board** ([mood.example.test](https://mood.example.test)) — Berkeley, CA 2026");
    expect(markdown).toContain("## Technical Skills\n- **Languages:** Python, TypeScript");
    expect(markdown).not.toContain("Pending text.");

    const variant = buildResumeVariant("local-candidate", null, "  Aurora Labs variant  ", [], document);
    expect(variant.label).toBe("Aurora Labs variant");
    expect(variant.document).toEqual(document);
  });

  it("renders section order, small-caps headings, and right-aligned places", () => {
    const html = renderResumeDocumentHtml(buildResumeDocument(PROFILE, ENTRIES));
    const order = ["Education", "Professional Experience", "Projects", "Technical Skills"].map((title) => html.indexOf(`<h2>${title}</h2>`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("<li><strong>Example State University</strong> — B.S. Computer Science, Engineering | GPA: 3.800 (Expected May 2028)</li>");
    expect(html).toContain('<section class="entry experience"><div class="entry-head"><span class="entry-name"><strong>Aurora Labs</strong> | Software Engineering Intern</span><span class="entry-meta">Berkeley, CA 2026</span></div>');
    expect(html).toContain('(<a href="https://mood.example.test">mood.example.test</a>)');
    expect(html).toContain("<li><strong>Languages:</strong> Python, TypeScript</li>");
    expect(html).toContain("font-variant:small-caps");
    // Lining figures: old-style digits made "2028" look uneven.
    expect(html).toContain("font-variant-numeric:lining-nums");
  });

  it("escapes entry text and drops non-http links", () => {
    const html = renderResumeDocumentHtml(buildResumeDocument({ fullName: "<b>Jordan</b>" }, [
      entry("55555555-5555-4555-8555-555555555555", "project", {
        title: "A & B <script>",
        linkLabel: "x",
        linkUrl: "https://ok.example.test",
        bullets: ["<img src=x onerror=alert(1)>"]
      })
    ]));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("A &amp; B &lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Jordan&lt;/b&gt;");
    const unsafe = renderResumeDocumentHtml({
      ...buildResumeDocument({ fullName: "Jordan" }, []),
      projects: [{ entryId: "55555555-5555-4555-8555-555555555555", revisionId: "55555555-5555-4555-8555-555555555556", title: "P", role: null, linkLabel: "x", linkUrl: "javascript:alert(1)", location: null, dateText: null, bullets: [] }]
    });
    expect(unsafe).not.toContain("javascript:");
  });

  it("omits education when the profile has no school or degree", () => {
    expect(buildResumeDocument({ fullName: "Jordan Rivera" }, []).education).toBe(null);
  });
});

describe("resume HTML for PDF conversion", () => {
  it("renders headings, bullets, bold, and links", () => {
    const html = renderResumeHtml([
      "# Jordan Rivera",
      "",
      "jordan@example.test • [GitHub](https://github.com/example)",
      "",
      "## Education",
      "- **Example State University** — B.S. Computer Science (Expected May 2028)",
      "",
      "## Experience",
      "- Shipped Python services in production."
    ].join("\n"));
    expect(html).toContain("<h1>Jordan Rivera</h1>");
    expect(html).toContain('<p>jordan@example.test • <a href="https://github.com/example">GitHub</a></p>');
    expect(html).toContain("<h2>Education</h2>");
    expect(html).toContain("<li><strong>Example State University</strong> — B.S. Computer Science (Expected May 2028)</li>");
    expect(html).toContain("<ul><li>Shipped Python services in production.</li></ul>");
  });

  it("escapes snapshot text and refuses non-http links", () => {
    const html = renderResumeHtml([
      "# <script>alert(1)</script>",
      "- Built [x](javascript:alert(1)) & <img src=x onerror=alert(1)>"
    ].join("\n"));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});
