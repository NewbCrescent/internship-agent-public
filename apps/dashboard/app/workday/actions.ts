"use server";

import { browserProfileBusy, connectWorkdaySite } from "@internship-agent/agent";
import { WORKDAY_SITE_KEY } from "@internship-agent/domain";

import type { WorkdayActionState } from "./action-state";
import { getActiveDatabase, getActiveDataDirectory } from "@/lib/active-profile";

/**
 * Opens a visible sign-in window for one Workday site and returns at once;
 * the window records the outcome when the candidate closes it.
 */
export async function connectWorkdaySiteAction(_previous: WorkdayActionState, formData: FormData): Promise<WorkdayActionState> {
  try {
    const siteKey = String(formData.get("siteKey") ?? "");
    if (!WORKDAY_SITE_KEY.test(siteKey)) throw new Error("That is not a Workday site.");
    const [database, dataDir] = await Promise.all([getActiveDatabase(), getActiveDataDirectory()]);
    const busy = browserProfileBusy(dataDir);
    if (busy) return { status: "error", message: busy };
    void connectWorkdaySite(siteKey, { database, dataDir }).catch(() => undefined);
    return { status: "success", message: "A browser window opened on this Workday site. Sign in or create your account there, close the window when you are done, then refresh this page." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
