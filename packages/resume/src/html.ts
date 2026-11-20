import type { ResumeDocument, ResumeDocumentEntry } from "@internship-agent/domain";

import { contactParts, educationLine, RESUME_SECTION_TITLES } from "./document";

/**
 * Renders the frozen resume markdown snapshot to standalone, print-ready
 * HTML for PDF conversion. It understands only the subset that
 * legacy variant snapshots emit (headings, paragraphs, bullets, a fully
 * italic line, `**bold**`, and `[label](https://…)` links) and escapes
 * everything else, so snapshot text can never inject markup into the
 * rendered document. The styling mirrors the candidate's own resume: a
 * centered name and contact line, uppercase ruled section headings, and a
 * compact serif body.
 */
export function renderResumeHtml(markdown: string, title = "Resume"): string {
  const body: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) body.push("</ul>");
    listOpen = false;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("- ")) {
      if (!listOpen) body.push("<ul>");
      listOpen = true;
      body.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith("## ")) body.push(`<h2>${renderInline(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) body.push(`<h1>${renderInline(line.slice(2))}</h1>`);
    else if (/^_.+_$/.test(line)) body.push(`<p><em>${renderInline(line.slice(1, -1))}</em></p>`);
    else body.push(`<p>${renderInline(line)}</p>`);
  }
  closeList();

  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`,
    `<style>${RESUME_CSS}</style></head>`,
    `<body>${body.join("")}</body></html>`
  ].join("");
}

/**
 * Renders a frozen structured resume in the candidate's own layout:
 * centered name and linked contact line; uppercase ruled section headings;
 * experience headings in small caps as "Organization | Role" with location
 * and date right-aligned; projects with their link; skills as
 * "Label: items". Every value is escaped and only http(s) links render.
 */
export function renderResumeDocumentHtml(document: ResumeDocument): string {
  const body: string[] = [];
  body.push(`<h1>${escapeHtml(document.header.fullName)}</h1>`);
  const contact = contactParts(document.header).map((part) => link(part.label, part.url));
  if (contact.length > 0) body.push(`<p class="contact">${contact.join(" • ")}</p>`);

  if (document.education) {
    body.push(sectionHeading(RESUME_SECTION_TITLES.education));
    // Mark the school with control characters, escape the whole line, then
    // turn the marks into <strong> so the school text itself stays escaped.
    const line = educationLine(document.education, (school) => `\u0000${school}\u0001`);
    body.push(`<ul><li>${escapeHtml(line).replace("\u0000", "<strong>").replace("\u0001", "</strong>")}</li></ul>`);
  }
  if (document.experience.length > 0) {
    body.push(sectionHeading(RESUME_SECTION_TITLES.experience));
    for (const entry of document.experience) body.push(entryHtml(entry, "experience"));
  }
  if (document.projects.length > 0) {
    body.push(sectionHeading(RESUME_SECTION_TITLES.projects));
    for (const entry of document.projects) body.push(entryHtml(entry, "project"));
  }
  if (document.skills.length > 0) {
    body.push(sectionHeading(RESUME_SECTION_TITLES.skills));
    body.push(`<ul>${document.skills.map((group) =>
      `<li><strong>${escapeHtml(group.title)}:</strong> ${escapeHtml(group.bullets.join(", "))}</li>`
    ).join("")}</ul>`);
  }

  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(document.header.fullName)} Resume</title>`,
    `<style>${RESUME_CSS}${DOCUMENT_CSS}</style></head>`,
    `<body>${body.join("")}</body></html>`
  ].join("");
}

function sectionHeading(title: string): string {
  return `<h2>${escapeHtml(title)}</h2>`;
}

function entryHtml(entry: ResumeDocumentEntry, kind: "experience" | "project"): string {
  const title = `<strong>${escapeHtml(entry.title)}</strong>`;
  const name = entry.role ? `${title} | ${escapeHtml(entry.role)}` : title;
  const linkText = entry.linkUrl ? ` (${link(entry.linkLabel ?? entry.linkUrl, entry.linkUrl)})` : "";
  const place = [entry.location, entry.dateText].filter(Boolean).join(" ");
  const bullets = entry.bullets.length > 0
    ? `<ul>${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
    : "";
  return `<section class="entry ${kind}"><div class="entry-head"><span class="entry-name">${name}${linkText}</span>`
    + `${place ? `<span class="entry-meta">${escapeHtml(place)}</span>` : ""}</div>${bullets}</section>`;
}

function link(label: string, url: string | null): string {
  if (!url || !/^https?:\/\//i.test(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

const DOCUMENT_CSS = [
  "p.contact{text-align:center;margin:0 0 6pt;font-size:10pt;overflow-wrap:anywhere}",
  ".entry{margin:0 0 3pt;break-inside:avoid}",
  ".entry-head{display:flex;justify-content:space-between;align-items:baseline;gap:12pt}",
  ".entry-meta{font-weight:700;white-space:nowrap}",
  ".experience .entry-name,.experience .entry-meta{font-variant:small-caps}",
  ".entry ul{margin-top:1pt}"
].join("");

const RESUME_CSS = [
  "@page{size:Letter;margin:0.5in 0.6in}",
  // Hoefler Text and Garamond default to old-style figures, where "8" rises
  // above "202"; lining figures keep years, GPAs, and metrics even.
  "body{font-family:'EB Garamond',Garamond,'Hoefler Text',Palatino,'Palatino Linotype',Georgia,serif;font-variant-numeric:lining-nums;font-size:10.5pt;line-height:1.3;color:#000;margin:0}",
  "h1{font-size:14pt;font-weight:700;margin:0 0 2pt;text-align:center}",
  "h1+p{text-align:center;margin:0 0 6pt;font-size:10pt;overflow-wrap:anywhere}",
  "a{color:#1155cc;text-decoration:underline}",
  "h2{font-size:11pt;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;margin:6pt 0 3pt;padding-bottom:1pt}",
  "p{margin:0 0 3pt}",
  "ul{margin:0 0 3pt;padding-left:22pt;list-style-type:disc}",
  "li{margin:0 0 1pt;padding-left:2pt}"
].join("");

const INLINE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;

/** Escapes text and renders only bold spans and http(s) links. */
function renderInline(text: string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    html += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined && match[2] !== undefined) {
      html += `<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`;
    } else {
      html += `<strong>${escapeHtml(match[3] ?? "")}</strong>`;
    }
    last = (match.index ?? 0) + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
