import { renderCandidateResumePreview } from "@internship-agent/agent";

import { getActiveDataDirectory, getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

/** Streams the active profile's current resume as a PDF for inspection. */
export async function GET(): Promise<Response> {
  const [database, dataDir] = await Promise.all([getActiveDatabase(), getActiveDataDirectory()]);
  const preview = await renderCandidateResumePreview({ database, dataDir });
  if (!preview) return new Response("Create the profile before previewing a resume.", { status: 404 });
  return new Response(Buffer.from(preview.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=\"resume-preview.pdf\"",
      "Cache-Control": "no-store",
      "X-Resume-Pages": String(preview.pages)
    }
  });
}
