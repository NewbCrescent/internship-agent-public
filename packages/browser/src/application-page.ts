import type { Page } from "playwright-core";

import { icimsAccountSteps, type IcimsAccountSteps } from "./ats/icims-account";
import { passJobviteConsent, type JobviteConsentOutcome } from "./ats/jobvite-consent";
import { createPlaywrightPage, ensureNameShim, type BrowserPage } from "./handshake-executor";
import { advanceToApplicationForm, readStepButtonsIn, type NavigationOutcome, type StepButtons } from "./site-navigation";

/**
 * The page adapter generic (non-Workday) runs open: the Playwright page plus
 * iCIMS's account steps and Jobvite's data-consent step, which the
 * orchestrator takes only when the candidate's settings allow it, the
 * bounded navigation toward an unrecognized site's form
 * (site-navigation.ts), and the page's step buttons.
 */
export type ApplicationPage = BrowserPage & {
  icims: IcimsAccountSteps;
  jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome>;
  /** Walks toward the application form (reject cookies, guest, Apply, manual, continue; at most four entries). */
  advanceToApplicationForm(): Promise<NavigationOutcome>;
  /** Whether the page shows a submit control, and its "Next" control if any. */
  stepButtons(): Promise<StepButtons>;
};

export function createApplicationPage(page: Page): ApplicationPage {
  return {
    ...createPlaywrightPage(page),
    icims: icimsAccountSteps(page),
    jobviteConsent: (choose) => passJobviteConsent(page, choose),
    advanceToApplicationForm: () => advanceToApplicationForm(page),
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

export function hasJobviteConsent(page: BrowserPage): page is BrowserPage & { jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome> } {
  return "jobviteConsent" in page;
}

export function hasSiteNavigation(page: BrowserPage): page is BrowserPage & { advanceToApplicationForm(): Promise<NavigationOutcome> } {
  return "advanceToApplicationForm" in page;
}

export function hasStepButtons(page: BrowserPage): page is BrowserPage & { stepButtons(): Promise<StepButtons> } {
  return "stepButtons" in page;
}
