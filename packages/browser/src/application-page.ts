import type { Page } from "playwright-core";

import { icimsAccountSteps, type IcimsAccountSteps } from "./ats/icims-account";
import { passJobviteConsent, type JobviteConsentOutcome } from "./ats/jobvite-consent";
import { oracleApplySteps, type OracleApplySteps } from "./ats/oracle-apply";
import { rejectCookieConsent } from "./cookie-consent";
import { createPlaywrightPage, ensureNameShim, type BrowserPage } from "./handshake-executor";
import { advanceToApplicationForm, readClosedPostingNotice, readStepButtonsIn, type NavigationOutcome, type StepButtons } from "./site-navigation";
import { STEP_NEXT_MARK, tagStepNextIn } from "./stepped-form";

/**
 * The page adapter generic (non-Workday) runs open: the Playwright page plus
 * iCIMS's account steps and Jobvite's data-consent step, which the
 * orchestrator takes only when the candidate's settings allow it, Oracle
 * Cloud HCM's email and one-time-code step (ats/oracle-apply.ts), which the
 * orchestrator takes with the saved email and the candidate's own mailbox,
 * the bounded navigation toward an unrecognized site's form
 * (site-navigation.ts), and the page's step buttons and its several-page
 * steps (stepped-form.ts).
 */
export type ApplicationPage = BrowserPage & {
  icims: IcimsAccountSteps;
  oracle: OracleApplySteps;
  jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome>;
  /** Walks toward the application form (reject cookies, guest, Apply, manual, continue; at most four entries). */
  advanceToApplicationForm(): Promise<NavigationOutcome>;
  /** Whether the page shows a submit control, and its "Next" control if any. */
  stepButtons(): Promise<StepButtons>;
  /** Clicks the step's own Next control (stepped-form.ts tagStepNextIn); false when none matched or the click failed. Never a submit control. */
  clickStepNext(text: string): Promise<boolean>;
  /** Rejects or takes necessary-only on a cookie banner (cookie-consent.ts). */
  rejectCookies(): Promise<unknown>;
  /** The closed-posting words on the page and its same-host frames (site-navigation.ts readClosedPostingNotice), or null. */
  postingClosedNotice(): Promise<string | null>;
};

export function createApplicationPage(page: Page): ApplicationPage {
  return {
    ...createPlaywrightPage(page),
    icims: icimsAccountSteps(page),
    oracle: oracleApplySteps(page),
    jobviteConsent: (choose) => passJobviteConsent(page, choose),
    advanceToApplicationForm: () => advanceToApplicationForm(page),
    postingClosedNotice: () => readClosedPostingNotice(page),
    rejectCookies: () => rejectCookieConsent(page).catch(() => null),
    clickStepNext: async (text) => {
      try {
        await ensureNameShim(page);
        if (!(await page.locator("body").evaluate(tagStepNextIn, text))) return false;
        await page.locator(`[${STEP_NEXT_MARK}]`).first().click({ timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    stepButtons: async () => {
      try {
        await ensureNameShim(page);
        return await page.locator("body").evaluate(readStepButtonsIn);
      } catch {
        // Unreadable: treated as a page with a submit control, so nothing stops on it.
        return { submit: true, next: null };
      }
    }
  };
}

export function hasIcimsSteps(page: BrowserPage): page is BrowserPage & { icims: IcimsAccountSteps } {
  return "icims" in page;
}

export function hasOracleSteps(page: BrowserPage): page is BrowserPage & { oracle: OracleApplySteps } {
  return "oracle" in page;
}

export function hasJobviteConsent(page: BrowserPage): page is BrowserPage & { jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome> } {
  return "jobviteConsent" in page;
}

export function hasSiteNavigation(page: BrowserPage): page is BrowserPage & { advanceToApplicationForm(): Promise<NavigationOutcome> } {
  return "advanceToApplicationForm" in page;
}

export function hasPostingClosedNotice(page: BrowserPage): page is BrowserPage & { postingClosedNotice(): Promise<string | null> } {
  return "postingClosedNotice" in page;
}

export function hasStepButtons(page: BrowserPage): page is BrowserPage & { stepButtons(): Promise<StepButtons> } {
  return "stepButtons" in page;
}
