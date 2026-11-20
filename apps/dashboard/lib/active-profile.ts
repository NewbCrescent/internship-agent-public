import "server-only";

import { cookies } from "next/headers";

import { getProfileDatabase, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema, type WorkspaceProfile } from "@internship-agent/domain";

export const PROFILE_COOKIE = "internship-agent-profile";

export async function getActiveProfile(): Promise<WorkspaceProfile> {
  const selected = (await cookies()).get(PROFILE_COOKIE)?.value;
  if (selected) {
    const parsed = workspaceProfileSchema.safeParse(selected);
    if (parsed.success) return parsed.data;
  }
  return process.env.INTERNSHIP_AGENT_DEFAULT_PROFILE === "demo" ? "demo" : "real";
}

export async function getActiveDatabase() {
  return getProfileDatabase(await getActiveProfile());
}

export async function getActiveDataDirectory(): Promise<string> {
  return resolveProfileDataDirectory(await getActiveProfile());
}
