import type { Locator, Page } from "playwright-core";

import {
  chooseDegreeOption,
  educationRowsForSection,
  matchFieldOfStudyOption,
  matchPromptOption,
  promptSearchTerms,
  type ApplicationHistory,
  type DecisionBasis,
  type EducationRow,
  type FillDecision,
  type MonthYear,
  type PauseRecord,
  type WorkHistoryRow
} from "@internship-agent/domain";

import { ensureNameShim } from "../handshake-executor";
import {
  clickWorkdayControl,
  closeWorkdayLists,
  openWorkdayListbox,
  pickWorkdayListboxOption,
  pickWorkdayPromptOption,
  settleWorkdayOptions,
  workdayPromptOptions
} from "./workday-lists";

/**
 * Fills Workday's repeating My Experience sections (Work Experience and
 * Education) from the candidate's history. Sections and rows are found by
 * Workday's labelled groups or markers when present and by their headings otherwise; fields are
 * found by their labels, which stay stable across Workday versions. A row the
 * candidate did not choose is deleted and recorded; anything the filler cannot
 * match (a degree, a school in a search list) becomes a question for the
 * candidate instead of a guess. Any list still open is closed before an Add,
 * Delete, or dropdown click (a multi-select Field of Study list stays open
 * after a pick and covers the controls below it), and a covered control is
 * focused and activated with Enter instead of force-clicked. The Education
 * section gets the college rows only unless its own label asks for high school
 * or for every school attended (educationRowsForSection; the candidate's rule,
 * 2026-11-26); a high-school row already on the page is then deleted and
 * recorded like any row that is not the candidate's.
 */
export type HistoryFillResult = { decisions: FillDecision[]; pauses: PauseRecord[] };

type Kind = "work" | "education";

const FIELD = '[data-automation-id^="formField-"]';
const SECTION_ATTRIBUTE = "data-ia-section";
const PANEL_ATTRIBUTE = "data-ia-panel";
/** The longest a history-row action waits for its control (a re-drawn row's control stops resolving). */
const HISTORY_ACTION_MS = 5_000;
const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

const LABELS = {
  work: {
    title: /^\s*job title/i,
    company: /^\s*company/i,
    location: /^\s*location/i,
    current: /currently work here/i,
    from: /^\s*(?:from|start date)/i,
    to: /^\s*(?:to\b|end date)/i,
    description: /^\s*(?:role description|description)/i
  },
  education: {
    school: /^\s*(?:school|university|college|institution)/i,
    degree: /^\s*degree/i,
    field: /^\s*(?:field of study|major|area of study)/i,
    gpa: /^\s*(?:overall result|gpa|grade average|cumulative gpa)/i,
    from: /^\s*(?:from|first year attended|start|year (?:started|began|entered)|date (?:started|began|entered)|began|enrolled)/i,
    to: /^\s*(?:to\b|last year attended|end|graduat|expected|year (?:graduated|of graduation|completed|ended)|date (?:graduated|completed|received|earned|ended)|completion|degree (?:date|received|completed|earned|conferred))/i
  }
} as const;

/**
 * Tags the history sections and their row panels on the current step; returns the row count per section.
 * A section is Workday's `role="group"` labelled (`aria-labelledby`) "Work Experience" or "Education", else
 * its `workExperienceSection` / `educationSection` marker, else the nearest ancestor of its heading holding an
 * Add (Workday's `add-button`, or a button reading Add or Add Another). One element is never taken for both
 * sections (employer-e.wd5, 2026-11-25: every row "was not added" while no other field of the step was read).
 */
async function tagSections(page: Page): Promise<Record<Kind, number | null>> {
  return page.locator("body").evaluate((body, attributes) => {
    const [sectionAttribute, panelAttribute] = attributes;
    const found: Record<string, number | null> = { work: null, education: null };
    const specs: Array<[string, string, RegExp]> = [
      ["work", "workExperienceSection", /^work experience$/i],
      ["education", "educationSection", /^education$/i]
    ];
    const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const isAdd = (button: Element) => button.getAttribute("data-automation-id") === "add-button" || /^add(?: another)?$/i.test(text(button));
    const labelOf = (element: Element) => (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => body.ownerDocument.getElementById(id)).filter((label): label is HTMLElement => label !== null)
      .map(text).join(" ").replace(/\s+/g, " ").trim();
    const groups = Array.from(body.querySelectorAll('[role="group"][aria-labelledby]'));
    const chosen: Element[] = [];
    for (const [kind, marker, heading] of specs) {
      const matched = groups.filter((group) => heading.test(labelOf(group)));
      let section: Element | null = matched.find((group) => !matched.some((other) => other !== group && other.contains(group))) ?? null;
      section ??= body.querySelector(`[data-automation-id="${marker}"]`);
      if (!section) {
        const title = Array.from(body.querySelectorAll("h2, h3, h4, legend")).find((element) => heading.test(text(element)));
        let node = title?.parentElement ?? null;
        while (node && node !== body && !Array.from(node.querySelectorAll("button")).some(isAdd)) node = node.parentElement;
        section = node && node !== body ? node : null;
      }
      if (!section) continue;
      // The same element (or one holding the other) found for both sections is no section of either kind's own.
      const shared = section;
      if (chosen.some((other) => other === shared || other.contains(shared) || shared.contains(other))) continue;
      chosen.push(section);
      section.setAttribute(sectionAttribute, kind);
      const candidates = Array.from(section.querySelectorAll(`[role="group"], [data-automation-id^="workExperience-"], [data-automation-id^="education-"]`))
        .filter((element) => element.querySelector('[data-automation-id^="formField-"]'));
      const panels = candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
      for (const element of Array.from(section.querySelectorAll(`[${panelAttribute}]`))) element.removeAttribute(panelAttribute);
      panels.forEach((panel, index) => panel.setAttribute(panelAttribute, String(index)));
      found[kind] = panels.length;
    }
    return found as Record<"work" | "education", number | null>;
  }, [SECTION_ATTRIBUTE, PANEL_ATTRIBUTE] as const);
}

/** A tagged section's own label: its aria-labelledby text, else its first heading or legend, else "Education". */
async function sectionLabelOf(page: Page, kind: Kind): Promise<string> {
  return page.locator(`[${SECTION_ATTRIBUTE}="${kind}"]`).first().evaluate((section) => {
    const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const labelled = (section.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => section.ownerDocument.getElementById(id)).filter((label): label is HTMLElement => label !== null)
      .map(text).join(" ").trim();
    if (labelled) return labelled;
    const heading = section.querySelector("h2, h3, h4, legend");
    return (heading ? text(heading) : "") || "Education";
  }, undefined, { timeout: HISTORY_ACTION_MS }).catch(() => "Education");
}

const panel = (page: Page, kind: Kind, index: number) => page.locator(`[${SECTION_ATTRIBUTE}="${kind}"] [${PANEL_ATTRIBUTE}="${index}"]`).first();

/** A field found by its label, or (for some education fields) also by Workday's own container id. */
type FieldMatch = RegExp | { label: RegExp; automationId: string };

function fieldIn(page: Page, scope: Locator, match: FieldMatch): Locator {
  const label = match instanceof RegExp ? match : match.label;
  const byLabel = scope.locator(FIELD).filter({ has: page.locator("label, legend").filter({ hasText: label }) });
  return (match instanceof RegExp ? byLabel : byLabel.or(scope.locator(`[data-automation-id="${match.automationId}"]`))).first();
}

/** The value a row's identifying field shows: a typed company or school, or a picked school chip. */
async function keyOf(page: Page, scope: Locator, match: FieldMatch): Promise<string> {
  const container = fieldIn(page, scope, match);
  if (!(await container.count())) return "";
  const chip = container.locator('[data-automation-id="selectedItem"]').first();
  if (await chip.count()) return (await chip.innerText({ timeout: HISTORY_ACTION_MS })).trim();
  const input = container.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first();
  return (await input.count()) ? (await input.inputValue({ timeout: HISTORY_ACTION_MS })).trim() : "";
}

function sameName(a: string, b: string): boolean {
  return a.trim() !== "" && b.trim() !== "" && (matchPromptOption(a, [b]) !== null || matchPromptOption(b, [a]) !== null);
}

async function deletePanel(page: Page, kind: Kind, index: number): Promise<boolean> {
  const scope = panel(page, kind, index);
  const button = scope.locator('[data-automation-id="panel-set-delete-button"], button').filter({ hasText: /^\s*delete\s*$/i }).first();
  if (!(await button.count())) return false;
  await closeWorkdayLists(page);
  await clickWorkdayControl(page, button);
  await page.waitForTimeout(400);
  return true;
}

/** The section's Add: Workday's `add-button`, else a button reading Add or Add Another. */
async function addButtonOf(page: Page, kind: Kind): Promise<Locator> {
  const section = page.locator(`[${SECTION_ATTRIBUTE}="${kind}"]`).first();
  const marked = section.locator('[data-automation-id="add-button"]');
  return (await marked.count()) ? marked.last() : section.locator("button").filter({ hasText: /^\s*add(?: another)?\s*$/i }).last();
}

/**
 * Adds a row and returns its index. An Add that shows no new row within 8 s is clicked once more after
 * closing lists and re-tagging; a second miss returns null (the row's "did not add" question). A row the
 * first click added but that is counted only later is left blank and deleted at the end.
 */
async function addPanel(page: Page, kind: Kind): Promise<number | null> {
  const before = (await tagSections(page))[kind] ?? 0;
  for (let click = 0; click < 2; click += 1) {
    if (click > 0) {
      await closeWorkdayLists(page, true);
      await tagSections(page);
    }
    const add = await addButtonOf(page, kind);
    if (!(await add.count())) return null;
    await closeWorkdayLists(page);
    try {
      await clickWorkdayControl(page, add);
    } catch (error) {
      // An Add that never took the click is a missed Add, never a crash.
      if (!isTimeout(error)) throw error;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.waitForTimeout(200);
      const now = (await tagSections(page))[kind] ?? 0;
      if (now > before) return now - 1;
    }
  }
  return null;
}

async function typeInto(page: Page, input: Locator, value: string): Promise<void> {
  // A covered input is focused instead.
  await input.click({ timeout: 5_000 }).catch(() => input.focus({ timeout: HISTORY_ACTION_MS }));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value);
}

/**
 * Workday draws each date section's `dateSection…-display` over its spinbutton
 * input, so a click never reaches it (Sierra Space, ZOLL, Neogen, Aerospace,
 * 2026-11-24/25): focus it and type.
 */
export async function typeIntoDateSection(page: Page, input: Locator, value: string): Promise<void> {
  await input.focus({ timeout: HISTORY_ACTION_MS });
  if ((await input.inputValue({ timeout: HISTORY_ACTION_MS })) !== "") {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
  }
  await page.keyboard.type(value);
}

type Recorder = {
  fill(id: string, value: string, basis: DecisionBasis, reason: string): void;
  ask(id: string, label: string, question: string): void;
};

async function setText(page: Page, scope: Locator, match: FieldMatch, value: string | null, id: string, basis: DecisionBasis, record: Recorder, required = false): Promise<void> {
  if (value === null || value === "") return;
  const container = fieldIn(page, scope, match);
  if (!(await container.count())) {
    if (required) record.ask(id, id, `Workday's history row has no field for ${id.split(":").at(-1)}; enter "${value}" yourself.`);
    return;
  }
  const input = container.locator('textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])').first();
  if ((await input.inputValue({ timeout: HISTORY_ACTION_MS })) !== value) await input.fill(value, { timeout: HISTORY_ACTION_MS });
  record.fill(id, value, basis, "Entered from the candidate's own history.");
}

/** Labels of the row's date fields (date sections or a date input) that neither the From nor the To label reads. */
async function unrecognizedDateLabels(scope: Locator, kind: Kind): Promise<string[]> {
  const labels = await scope.evaluate((row) => Array.from(row.querySelectorAll('[data-automation-id^="formField-"]'))
    .filter((field) => field.querySelector('[data-automation-id^="dateSection"], input[type="date"]'))
    .map((field) => (field.querySelector("label, legend")?.textContent || field.querySelector("[aria-label]")?.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ").replace(/\*+$/, "").trim())
    .filter(Boolean), undefined, { timeout: HISTORY_ACTION_MS }).catch(() => [] as string[]);
  return labels.filter((text) => !LABELS[kind].from.test(text) && !LABELS[kind].to.test(text)).slice(0, 5).map((text) => text.slice(0, 60));
}

async function setDate(
  page: Page,
  scope: Locator,
  match: FieldMatch,
  value: MonthYear | number | null,
  id: string,
  basis: DecisionBasis,
  record: Recorder,
  required = false,
  kind: Kind = "work"
): Promise<void> {
  if (value === null) return;
  const container = fieldIn(page, scope, match);
  if (!(await container.count())) {
    // Optional dates (an education start year) may simply not be on the form.
    if (!required) return;
    const unread = await unrecognizedDateLabels(scope, kind);
    // An education row with no end-date field at all has nothing to fill; Workday's own check decides.
    if (kind === "education" && unread.length === 0) return;
    const field = id.split(":").at(-1);
    record.ask(id, id, `Workday's history row has no ${field} date field this run recognizes${unread.length ? ` (its date fields: ${unread.join("; ")})` : ""}; enter it yourself.`);
    return;
  }
  const month = container.locator('[data-automation-id="dateSectionMonth-input"]').first();
  const year = container.locator('[data-automation-id="dateSectionYear-input"]').first();
  const yearValue = typeof value === "number" ? value : value.year;
  if (await month.count()) {
    if (typeof value === "number") {
      record.ask(id, id, `Workday asks for a month here, and only the year ${value} is recorded; enter the month yourself.`);
      return;
    }
    await typeIntoDateSection(page, month, String(value.month).padStart(2, "0"));
  }
  if (await year.count()) {
    await typeIntoDateSection(page, year, String(yearValue));
  } else {
    const plain = container.locator('input:not([type="hidden"])').first();
    if (!(await plain.count())) return;
    await typeInto(page, plain, typeof value === "number" ? String(value) : `${String(value.month).padStart(2, "0")}/${value.year}`);
  }
  record.fill(id, typeof value === "number" ? String(value) : `${String(value.month).padStart(2, "0")}/${value.year}`, basis, "Entered from the candidate's own dates.");
}

/** Picks a listbox option or a search-and-pick option with `choose`; asks when nothing fits. */
async function setChoice(
  page: Page,
  scope: Locator,
  match: FieldMatch,
  wanted: string | null,
  choose: (options: string[]) => string | null,
  id: string,
  basis: DecisionBasis,
  record: Recorder,
  answer: string | undefined
): Promise<void> {
  if (wanted === null) return;
  const container = fieldIn(page, scope, match);
  if (!(await container.count())) return;
  const pick = (options: string[]) => (answer ? options.find((option) => option.trim().toLocaleLowerCase("en-US") === answer.trim().toLocaleLowerCase("en-US")) ?? null : choose(options));
  const listbox = container.locator('button[aria-haspopup="listbox"]').first();
  if (await listbox.count()) {
    const shown = (await listbox.innerText({ timeout: HISTORY_ACTION_MS })).trim();
    // Read only the list this button opened, once it stops changing (workday-lists.ts).
    const texts = await openWorkdayListbox(page, listbox);
    const option = pick(texts);
    const noFit = `No ${id.split(":").at(-1)} option on this Workday site fits "${wanted}". Options: ${texts.slice(0, 12).join("; ")}. Answer with one of them.`;
    if (!option) {
      await closeWorkdayLists(page, true);
      record.ask(id, id, noFit);
      return;
    }
    if (shown !== option) {
      if (!(await pickWorkdayListboxOption(page, listbox, option))) {
        await closeWorkdayLists(page, true);
        record.ask(id, id, noFit);
        return;
      }
    } else await closeWorkdayLists(page, true);
    // A pick can re-render the rows; tag them again so the row stays addressable.
    await tagSections(page);
    record.fill(id, option, basis, `Chose "${option}" for "${wanted}".`);
    return;
  }
  if (!(await container.locator('[data-automation-id="multiselectInputContainer"], [data-automation-id="selectedItemList"]').count())) {
    // A plain text box takes the candidate's own wording.
    const text = container.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])').first();
    if (!(await text.count())) return;
    if ((await text.inputValue({ timeout: HISTORY_ACTION_MS })) !== wanted) await text.fill(wanted, { timeout: HISTORY_ACTION_MS });
    // A text entry can re-draw the row (a suggestion list opens); tag it again, as after a pick.
    await tagSections(page);
    record.fill(id, wanted, basis, "Entered from the candidate's own history.");
    return;
  }
  const input = container.locator('[data-automation-id="multiselectInputContainer"] input').first();
  if (!(await input.count())) return;
  const chip = container.locator('[data-automation-id="selectedItem"]').first();
  if ((await chip.count()) && pick([(await chip.innerText({ timeout: HISTORY_ACTION_MS })).trim()])) {
    record.fill(id, (await chip.innerText({ timeout: HISTORY_ACTION_MS })).trim(), basis, "Workday already shows the matching option.");
    return;
  }
  const seen: string[] = [];
  for (const term of answer ? [answer] : promptSearchTerms(wanted)) {
    await typeInto(page, input, term);
    await page.keyboard.press("Enter");
    // Picked items (chips) never count as offered options.
    const texts = await settleWorkdayOptions(page, () => workdayPromptOptions(page), 3_000);
    seen.push(...texts);
    const option = pick(texts);
    if (option && await pickWorkdayPromptOption(page, option)) {
      await page.waitForTimeout(300);
      // A multi-select list (Field of Study) stays open after a pick and covers the controls below it.
      await closeWorkdayLists(page);
      await tagSections(page);
      record.fill(id, option, basis, `Picked "${option}" for "${wanted}".`);
      return;
    }
  }
  await closeWorkdayLists(page, true);
  record.ask(id, id, `Workday's list has no match for "${wanted}"${seen.length ? ` (it offered: ${[...new Set(seen)].slice(0, 10).join("; ")})` : ""}. Answer with the option to pick.`);
}

/**
 * Runs one history-row field: closes a list left open and re-tags the sections first (Workday can re-draw a
 * row, dropping the tags, after a text entry, an Escape, or a pick: ZOLL 2026-11-25 lost education row 1's
 * Degree for 30 s). A control that still does not respond is retried once after re-tagging, then becomes the
 * row's question; it never stops the run.
 */
async function rowField(page: Page, record: Recorder, id: string, label: string, action: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await closeWorkdayLists(page);
    await tagSections(page);
    try {
      await action();
      return;
    } catch (error) {
      if (!isTimeout(error)) throw error;
      await closeWorkdayLists(page, true);
    }
  }
  record.ask(id, id, `Workday's ${label} control on this row did not respond; enter it yourself.`);
}

async function fillWorkRow(page: Page, scope: Locator, row: WorkHistoryRow, record: Recorder): Promise<void> {
  const id = (field: string) => `history:work:${row.company}:${field}`;
  const basis: DecisionBasis = { kind: "resume_entry", entryId: row.entryId };
  const labels = LABELS.work;
  const field = (fieldId: string, label: string, action: () => Promise<void>) => rowField(page, record, fieldId, label, action);
  await field(id("title"), "Job Title", () => setText(page, scope, labels.title, row.title, id("title"), basis, record, true));
  await field(id("company"), "Company", () => setText(page, scope, labels.company, row.company, id("company"), basis, record, true));
  await field(id("location"), "Location", () => setText(page, scope, labels.location, row.location, id("location"), basis, record));
  await field(id("current"), "I currently work here", async () => {
    const current = fieldIn(page, scope, labels.current).locator('input[type="checkbox"]').first();
    if (await current.count()) {
      await current.setChecked(row.current, { timeout: HISTORY_ACTION_MS });
      if (row.current) record.fill(id("current"), "true", basis, "The entry is marked current.");
    }
  });
  if (!row.start) record.ask(id("from"), id("from"), `${row.company} has no start month on the Resume page; add it there or enter it here.`);
  await field(id("from"), "From", () => setDate(page, scope, labels.from, row.start, id("from"), basis, record, true));
  if (!row.current) {
    if (!row.end) record.ask(id("to"), id("to"), `${row.company} has no end month on the Resume page; add it there or enter it here.`);
    await field(id("to"), "To", () => setDate(page, scope, labels.to, row.end, id("to"), basis, record, true));
  }
  await field(id("description"), "Role Description", () => setText(page, scope, labels.description, row.description || null, id("description"), basis, record));
}

/** The field is required (a trailing * or aria-required) and shows no value: no picked item, "Select One", or empty inputs. */
async function requiredAndEmpty(page: Page, scope: Locator, match: FieldMatch): Promise<boolean> {
  const container = fieldIn(page, scope, match);
  if (!(await container.count())) return false;
  return container.evaluate((field) => {
    const label = (field.querySelector("label, legend")?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!/\*$/.test(label) && !field.querySelector('[aria-required="true"]')) return false;
    if (field.querySelector('[data-automation-id="selectedItem"]')) return false;
    const button = field.querySelector('button[aria-haspopup="listbox"]');
    if (button) return /^(?:select one)?$/i.test((button.textContent ?? "").trim());
    return Array.from(field.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'))
      .every((input) => (input as HTMLInputElement).value.trim() === "");
  }, undefined, { timeout: HISTORY_ACTION_MS }).catch(() => false);
}

async function fillEducationRow(page: Page, scope: Locator, row: EducationRow, record: Recorder, answers: Map<string, string>): Promise<void> {
  const id = (field: string) => `history:education:${row.school}:${field}`;
  const basis = (field: string): DecisionBasis => ({ kind: "profile", field: row.key === "college" ? field : `highSchool.${field}` });
  const labels = LABELS.education;
  const fromMatch: FieldMatch = { label: labels.from, automationId: "formField-firstYearAttended" };
  const toMatch: FieldMatch = { label: labels.to, automationId: "formField-lastYearAttended" };
  const fieldMatch: FieldMatch = { label: labels.field, automationId: "formField-fieldOfStudy" };
  const field = (fieldId: string, label: string, action: () => Promise<void>) => rowField(page, record, fieldId, label, action);
  await field(id("school"), "School", async () => {
    if (!(await fieldIn(page, scope, labels.school).count())) {
      record.ask(id("school"), id("school"), `Workday's education row has no school field; enter "${row.school}" yourself.`);
    }
  });
  await field(id("school"), "School", () => setChoice(page, scope, labels.school, row.school, (options) => matchPromptOption(row.school, options), id("school"), basis("school"), record, answers.get(id("school"))));
  await field(id("degree"), "Degree", () => setChoice(page, scope, labels.degree, row.degree ?? (row.level === "high_school" ? "High School Diploma" : null),
    (options) => chooseDegreeOption(row, options), id("degree"), basis("degree"), record, answers.get(id("degree"))));
  const fieldAnswer = answers.get(id("field"));
  const fieldWanted = row.fieldOfStudy ?? fieldAnswer ?? null;
  await field(id("field"), "Field of Study", async () => {
    if (fieldWanted) {
      await setChoice(page, scope, fieldMatch, fieldWanted, (options) => matchFieldOfStudyOption(fieldWanted, options), id("field"), basis("fieldOfStudy"), record, fieldAnswer);
    } else if (await requiredAndEmpty(page, scope, fieldMatch)) {
      // Nothing saved states this row's field of study (a high school): ask before the step is saved.
      record.ask(id("field"), id("field"), `Workday requires a field of study for ${row.school}, and none is saved for it. Answer with the field of study to enter.`);
    }
  });
  await field(id("gpa"), "Overall Result (GPA)", () => setText(page, scope, labels.gpa, row.gpa, id("gpa"), basis("gpa"), record));
  await field(id("from"), "From", () => setDate(page, scope, fromMatch, row.startYear, id("from"), basis("educationStartMonth"), record, false, "education"));
  await field(id("to"), "To", () => setDate(page, scope, toMatch, row.endYear, id("to"), basis("graduationDate"), record, true, "education"));
}

/**
 * Makes each history section hold exactly the candidate's rows: deletes rows
 * that are not theirs, reuses a row already showing the same company or
 * school, adds the rest, and fills every row. Returns null when the step has
 * no history section.
 */
export async function fillWorkdayHistory(
  page: Page,
  history: ApplicationHistory,
  answers: Map<string, string> = new Map()
): Promise<HistoryFillResult | null> {
  // The in-page section reader is compiled code; without the shim tsx builds throw `__name is not defined`.
  await ensureNameShim(page);
  const counts = await tagSections(page);
  if (counts.work === null && counts.education === null) return null;
  const result: HistoryFillResult = { decisions: [], pauses: [] };
  const record: Recorder = {
    fill: (fieldId, value, basis, reason) => result.decisions.push({ fieldId, action: "fill", value, basis, reason, pause: null }),
    ask: (fieldId, label, question) => {
      // An answer that was tried and did not fit is said so, and the question stays open.
      const tried = answers.get(fieldId);
      const text = tried ? `Your answer "${tried}" did not match. ${question}` : question;
      result.pauses.push({
        fieldId, label: label.slice(0, 300), question: text.slice(0, 500), suggestedKey: null, suggestedScope: null,
        safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null
      });
    }
  };

  // The candidate's rule (2026-11-26): the high school only where the section asks for it or for every school.
  const educationRows = counts.education === null ? [] : educationRowsForSection(history.education, await sectionLabelOf(page, "education"));
  const plans: Array<{ kind: Kind; key: RegExp; rows: Array<{ name: string; fill: (scope: Locator) => Promise<void> }> }> = [
    { kind: "work", key: LABELS.work.company, rows: history.work.map((row) => ({ name: row.company, fill: (scope) => fillWorkRow(page, scope, row, record) })) },
    { kind: "education", key: LABELS.education.school, rows: educationRows.map((row) => ({ name: row.school, fill: (scope) => fillEducationRow(page, scope, row, record, answers) })) }
  ];
  for (const plan of plans) {
    if (counts[plan.kind] === null) continue;
    // Delete rows that are not the candidate's (a resume parse, an old draft).
    for (let guard = 0; guard < 20; guard += 1) {
      const total = (await tagSections(page))[plan.kind] ?? 0;
      let removed = false;
      for (let index = 0; index < total; index += 1) {
        const key = await keyOf(page, panel(page, plan.kind, index), plan.key);
        if (key && !plan.rows.some((row) => sameName(row.name, key))) {
          if (!(await deletePanel(page, plan.kind, index))) break;
          result.decisions.push({
            fieldId: `history:${plan.kind}:${key}:row`, action: "remove", value: key, basis: null,
            reason: `Deleted "${key}": it is not one of the rows you chose for application history.`, pause: null
          });
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    const used = new Set<number>();
    for (const row of plan.rows) {
      const total = (await tagSections(page))[plan.kind] ?? 0;
      let target: number | null = null;
      for (let index = 0; index < total && target === null; index += 1) {
        if (!used.has(index) && sameName(row.name, await keyOf(page, panel(page, plan.kind, index), plan.key))) target = index;
      }
      for (let index = 0; index < total && target === null; index += 1) {
        if (!used.has(index) && !(await keyOf(page, panel(page, plan.kind, index), plan.key))) target = index;
      }
      target ??= await addPanel(page, plan.kind);
      if (target === null) {
        record.ask(`history:${plan.kind}:${row.name}:row`, `${plan.kind} history`, `Workday did not add a ${plan.kind === "work" ? "Work Experience" : "Education"} row for ${row.name}; add it yourself.`);
        continue;
      }
      used.add(target);
      await row.fill(panel(page, plan.kind, target));
    }
    // A leftover blank row would block Save and Continue.
    for (let index = ((await tagSections(page))[plan.kind] ?? 0) - 1; index >= 0; index -= 1) {
      if (!used.has(index) && !(await keyOf(page, panel(page, plan.kind, index), plan.key))) await deletePanel(page, plan.kind, index);
    }
  }
  return result;
}
