import type { Page } from "playwright-core";

import { icimsAccountSteps, type IcimsAccountSteps } from "./ats/icims-account";
import { passJobviteConsent, type JobviteConsentOutcome } from "./ats/jobvite-consent";
import { createPlaywrightPage, type BrowserPage } from "./handshake-executor";

/**
 * The page adapter generic (non-Workday) runs open: the Playwright page plus
 * iCIMS's account steps and Jobvite's data-consent step, which the
 * orchestrator takes only when the candidate's settings allow it.
 */
export type ApplicationPage = BrowserPage & {
  icims: IcimsAccountSteps;
  jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome>;
};

export function createApplicationPage(page: Page): ApplicationPage {
  return {
    ...createPlaywrightPage(page),
    icims: icimsAccountSteps(page),
    jobviteConsent: (choose) => passJobviteConsent(page, choose)
  };
}

export function hasIcimsSteps(page: BrowserPage): page is BrowserPage & { icims: IcimsAccountSteps } {
  return "icims" in page;
}

export function hasJobviteConsent(page: BrowserPage): page is BrowserPage & { jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome> } {
  return "jobviteConsent" in page;
}
