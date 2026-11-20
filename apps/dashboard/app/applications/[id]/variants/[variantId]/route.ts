import { readFileSync } from "node:fs";

import { listJobResumeVariants, printResumeVariant } from "@internship-agent/agent";

import { getActiveDataDirectory, getActiveDatabase } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Streams a frozen resume variant printed exactly as an upload would print it. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; variantId: string }> }
): Promise<Response> {
  const { id, variantId } = await params;
  if (!UUID.test(id) || !UUID.test(variantId)) return new Response("Unknown resume variant.", { status: 404 });
  const [database, dataDir] = await Promise.all([getActiveDatabase(), getActiveDataDirectory()]);
  if (!listJobResumeVariants(id, database).some((variant) => variant.id === variantId)) {
    return new Response("Unknown resume variant.", { status: 404 });
  }
  const printed = await printResumeVariant(database, dataDir, id, variantId);
  if (!printed) return new Response("This variant has no printable snapshot.", { status: 404 });
  return new Response(readFileSync(printed.path), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="resume-${variantId}.pdf"`,
      "Cache-Control": "no-store",
      "X-Resume-Pages": String(printed.pages)
    }
  });
}
