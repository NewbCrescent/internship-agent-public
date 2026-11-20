import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright-core";

/**
 * Prints standalone HTML to a PDF with a throwaway headless Chromium. It never
 * navigates to a site and never uses the candidate's browser profile, so it
 * is unaffected by the visible-window default for application runs.
 */
export async function renderHtmlToPdf(html: string, outputPath: string): Promise<{ pages: number }> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const bytes = await page.pdf({ path: outputPath, format: "Letter", printBackground: true, preferCSSPageSize: true });
    return { pages: countPdfPages(bytes) };
  } finally {
    await browser.close();
  }
}

/**
 * Counts page objects in a PDF Chromium printed. Chromium writes page
 * dictionaries uncompressed, so `/Type /Page` (not `/Pages`) marks each one.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/** True when the file starts with the PDF signature. */
export function isPdfFile(path: string): boolean {
  return isPdfBytes(readFileSync(path));
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/** Page count of a PDF pdf-lib can read and copy (encrypted or damaged files give null). */
export async function readablePdfPages(bytes: Uint8Array): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes)).getPageCount();
  } catch {
    return null;
  }
}

/**
 * Appends every page of each extra PDF after the base PDF. Saved without
 * object streams, so page dictionaries stay uncompressed and countPdfPages
 * still counts the result.
 */
export async function appendPdfPages(base: Uint8Array, extras: ReadonlyArray<Uint8Array>): Promise<Uint8Array> {
  const merged = await PDFDocument.load(base);
  for (const extra of extras) {
    const source = await PDFDocument.load(extra);
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
  }
  return merged.save({ useObjectStreams: false });
}
