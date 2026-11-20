/**
 * Workday career sites: accounts, sessions, and applications are per site
 * (`{tenant}.wdN.myworkdayjobs.com/[locale/]{site}/...`), so a site key is
 * the host plus the site name.
 */
export type WorkdayLocation = { host: string; tenant: string; site: string; jobPath: string | null };

const WORKDAY_HOST = /^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
export const WORKDAY_SITE_KEY = /^workday:[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com\/[A-Za-z0-9_-]+$/;

export function parseWorkdayUrl(raw: string): WorkdayLocation | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const tenant = WORKDAY_HOST.exec(url.hostname)?.[1];
  if (url.protocol !== "https:" || !tenant) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const rest = LOCALE.test(parts[0] ?? "") ? parts.slice(1) : parts;
  const site = rest[0];
  if (!site || !/^[A-Za-z0-9_-]+$/.test(site)) return null;
  const jobPath = rest[1] === "job" && rest.length >= 3 ? rest.slice(2).join("/") : null;
  return { host: url.hostname, tenant, site, jobPath };
}

export function workdaySiteKey(location: Pick<WorkdayLocation, "host" | "site">): string {
  return `workday:${location.host}/${location.site}`;
}
