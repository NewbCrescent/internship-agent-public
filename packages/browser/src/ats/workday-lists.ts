import type { Locator, Page } from "playwright-core";

import { ensureNameShim } from "../handshake-executor";

/**
 * Workday's dropdown and search-and-pick lists open in a portal a moment after
 * the click, the previous list can still be on screen while it closes, and
 * picked items elsewhere on the step (the Country Phone Code chip) carry the
 * same option roles. So a list is read only after the previous one closed,
 * only from the list this button opened, and only once its options stop
 * changing.
 */
const LIST_WAIT_MS = 5_000;
const CLOSE_WAIT_MS = 2_000;
const POLL_MS = 150;
const CLICK_WAIT_MS = 5_000;

/** In the page: an open list (a portal, a listbox, a prompt's options) is on screen outside every field's picked items. */
function openListShown(body: Element): boolean {
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const lists = Array.from(body.ownerDocument.querySelectorAll('[data-automation-id="activeListContainer"], [role="listbox"], [data-automation-id="promptOption"]'));
  return lists.some((el) => visible(el) &&
    !el.closest('[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"]') &&
    !el.closest('[data-automation-id^="formField-"]'));
}

/**
 * In the page: the option texts of the list this button opened (the list its
 * `aria-controls` names, else the open `activeListContainer`, else a visible
 * listbox outside other fields and picked items). When `pick` is given, the
 * first option with exactly that text is marked `data-ia-pick="1"`.
 */
function listboxOptionsOf(button: Element, pick: string | null): string[] {
  const doc = button.ownerDocument;
  for (const marked of Array.from(doc.querySelectorAll("[data-ia-pick]"))) marked.removeAttribute("data-ia-pick");
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const own = button.closest('[data-automation-id^="formField-"]');
  let lists: Element[] = (button.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => doc.getElementById(id)).filter((el): el is HTMLElement => el !== null && visible(el));
  if (lists.length === 0) lists = Array.from(doc.querySelectorAll('[data-automation-id="activeListContainer"]')).filter(visible);
  if (lists.length === 0) {
    lists = Array.from(doc.querySelectorAll('[role="listbox"]')).filter((el) => {
      if (!visible(el) || el.closest('[data-automation-id="selectedItemList"]')) return false;
      const field = el.closest('[data-automation-id^="formField-"]');
      return field === null || field === own;
    });
  }
  const options = new Set<Element>();
  for (const list of lists) {
    for (const option of Array.from(list.querySelectorAll('[role="option"]'))) if (visible(option)) options.add(option);
  }
  const ordered = Array.from(options).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const texts: string[] = [];
  let marked = false;
  for (const option of ordered) {
    const text = ((option as HTMLElement).innerText ?? option.textContent ?? "").trim();
    if (!text) continue;
    texts.push(text);
    if (!marked && pick !== null && text === pick) {
      option.setAttribute("data-ia-pick", "1");
      marked = true;
    }
  }
  return texts;
}

/** In the page: the visible prompt options outside picked items; the first exact match for `pick` is marked `data-ia-pick="1"`. */
function promptOptionsShown(body: Element, pick: string | null): string[] {
  const doc = body.ownerDocument;
  for (const marked of Array.from(doc.querySelectorAll("[data-ia-pick]"))) marked.removeAttribute("data-ia-pick");
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const texts: string[] = [];
  let marked = false;
  for (const option of Array.from(doc.querySelectorAll('[data-automation-id="promptOption"]'))) {
    if (!visible(option) || option.closest('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"]')) continue;
    const text = ((option as HTMLElement).innerText ?? option.textContent ?? "").trim();
    if (!text) continue;
    texts.push(text);
    if (!marked && pick !== null && text === pick) {
      option.setAttribute("data-ia-pick", "1");
      marked = true;
    }
  }
  return texts;
}

/** Reads until two reads POLL_MS apart agree on a non-empty list; the last read when the time runs out. */
export async function settleWorkdayOptions(page: Page, read: () => Promise<string[]>, timeoutMs = LIST_WAIT_MS): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let previous: string[] = [];
  for (;;) {
    const now = await read();
    if (now.length > 0 && previous.length > 0 && now.join("\n") === previous.join("\n")) return now;
    previous = now;
    if (Date.now() >= deadline) return now;
    await page.waitForTimeout(POLL_MS);
  }
}

/** Closes an open list (Escape) and waits up to 2 s for it to go; `always` presses Escape even when none shows. */
export async function closeWorkdayLists(page: Page, always = false): Promise<void> {
  await ensureNameShim(page);
  const shown = () => page.locator("body").evaluate(openListShown).catch(() => false);
  if (!always && !(await shown())) return;
  await page.keyboard.press("Escape");
  const deadline = Date.now() + CLOSE_WAIT_MS;
  // A list that stays on screen is tolerated.
  while (Date.now() < deadline && (await shown())) await page.waitForTimeout(POLL_MS);
}

/**
 * Clicks a Workday control. When the click is not taken within 5 s (a list left open or a display
 * layer over it: the Add Another and Degree timeouts on Sierra Space, Micron, Rockwell and enGen,
 * 2026-11-25), it focuses the control and presses Enter, the keyboard's own activation. Never forces a click.
 * The focus is bounded too; a control that never resolves throws a TimeoutError for the caller.
 */
export async function clickWorkdayControl(page: Page, control: Locator): Promise<void> {
  try {
    await control.click({ timeout: CLICK_WAIT_MS });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    await control.focus({ timeout: CLICK_WAIT_MS });
    await page.keyboard.press("Enter");
  }
}

/** Opens a dropdown and returns its options once they stop changing; the list stays open. */
export async function openWorkdayListbox(page: Page, button: Locator): Promise<string[]> {
  await closeWorkdayLists(page);
  await clickWorkdayControl(page, button);
  return settleWorkdayOptions(page, () => button.evaluate(listboxOptionsOf, null, { timeout: 2_000 }).catch(() => [] as string[]));
}

/** Clicks the option with exactly this text in the list the button opened; false when that list does not offer it. */
export async function pickWorkdayListboxOption(page: Page, button: Locator, option: string): Promise<boolean> {
  const texts = await button.evaluate(listboxOptionsOf, option, { timeout: 2_000 }).catch(() => [] as string[]);
  if (!texts.includes(option)) return false;
  await page.locator('[data-ia-pick="1"]').first().click({ timeout: CLICK_WAIT_MS });
  return true;
}

/** The prompt options on screen, outside picked items. */
export async function workdayPromptOptions(page: Page): Promise<string[]> {
  await ensureNameShim(page);
  return page.locator("body").evaluate(promptOptionsShown, null).catch(() => [] as string[]);
}

/** Clicks the prompt option with exactly this text (never a picked item); false when none shows. */
export async function pickWorkdayPromptOption(page: Page, option: string): Promise<boolean> {
  await ensureNameShim(page);
  const texts = await page.locator("body").evaluate(promptOptionsShown, option).catch(() => [] as string[]);
  if (!texts.includes(option)) return false;
  await page.locator('[data-ia-pick="1"]').first().click({ timeout: CLICK_WAIT_MS });
  return true;
}
