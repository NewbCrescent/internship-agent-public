"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { workspaceProfileSchema } from "@internship-agent/domain";

import { PROFILE_COOKIE } from "@/lib/active-profile";

export async function switchProfileAction(formData: FormData): Promise<void> {
  const profile = workspaceProfileSchema.parse(formData.get("profile"));
  (await cookies()).set(PROFILE_COOKIE, profile, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365
  });
  redirect("/");
}
