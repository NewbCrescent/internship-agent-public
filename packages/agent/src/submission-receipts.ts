import {
  closeProfileDatabase, getProfileDatabase, listApplicationReceiptAttempts, recordApplicationReceipt,
  type ApplicationReceiptAttempt, type ReceiptResult
} from "@internship-agent/db";
import type { WorkspaceProfile } from "@internship-agent/domain";

import { refreshApplicationHolds } from "./application-holds";
import type { MailSession, MailSessionFactory } from "./mail-watch";
import { ATS_DOMAINS, atsTenant, companyKey, mailItemKey, senderDomain, verificationSubject, type MailHeader } from "./mail-outcomes";

const STRICT_RECEIPT = /\b(?:(?:we (?:have )?)?received your application|your application (?:has been|was) received|application (?:received|successfully submitted)|thank you for (?:submitting your application|applying for (?:the|our))|your application (?:has been |was )?(?:successfully submitted|submitted successfully))\b/i;
const NON_RECEIPT = /\b(?:verify (?:your )?(?:account|e-?mail)|verification code|activate your account|confirm your email|reset your password|application (?:is |was |has been )?(?:not (?:yet )?(?:received|submitted)|incomplete|unsubmitted)|(?:not|never|no|haven[’']t|hasn[’']t) (?:yet )?(?:received your application|application received|submitted)|(?:once|if|after) we (?:have )?received your application|finish (?:your|the) application|complete your application)\b/i;
const PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  greenhouse: ["greenhouse.io", "greenhouse-mail.io"], lever: ["lever.co"], ashby: ["ashbyhq.com"],
  workday: ["myworkday.com", "workday.com", "myworkdayjobs.com"], oracle: ["oraclecloud.com"],
  smartrecruiters: ["smartrecruiters.com"], jobvite: ["jobvite.com"], icims: ["icims.com"],
  dover: ["dover.com"], rippling: ["rippling.com"]
};
const BODY_BYTES = 65_536;
const MAX_UIDS = 300;
const MAX_BODIES = 100;
const MAX_DAYS = 14;
const MAX_CHECK_MS = 45_000;

const domainMatches = (domain: string, allowed: string): boolean => domain === allowed || domain.endsWith(`.${allowed}`);

function words(text: string): string {
  return text.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

function host(url: string | null): string {
  return url ? (URL.parse(url)?.hostname ?? "").replace(/^(?:www|career|careers|jobs)\./, "") : "";
}

function employerSender(domain: string, attempt: ApplicationReceiptAttempt): boolean {
  const careerHost = host(attempt.companyCareersUrl);
  const name = companyKey(attempt.companyName).replace(/ /g, "");
  return [careerHost, host(attempt.sourceUrl), host(attempt.applicationUrl)].some((employer) => {
    const brand = employer.split(".").slice(-2, -1)[0]?.replace(/-/g, "");
    return employer !== "" && (employer === careerHost || (name.length > 2 && brand === name))
      && !ATS_DOMAINS.some((known) => domainMatches(employer, known)) && domainMatches(domain, employer);
  });
}

function providerSender(domain: string, attempt: ApplicationReceiptAttempt): boolean {
  const sites = [host(attempt.applicationUrl), host(attempt.sourceUrl)];
  return Object.entries(PROVIDERS).some(([provider, domains]) =>
    (attempt.atsKind === provider || sites.some((site) => domains.some((known) => domainMatches(site, known))))
      && domains.some((known) => domainMatches(domain, known)));
}

function sentAfter(header: MailHeader, attempt: ApplicationReceiptAttempt): boolean {
  return header.receivedAt.getTime() > Date.parse(attempt.attemptedAt);
}

export function receiptHeaderRelevant(header: MailHeader, attempts: ReadonlyArray<ApplicationReceiptAttempt>): boolean {
  if (verificationSubject(header.subject) || NON_RECEIPT.test(header.subject)) return false;
  const domain = senderDomain(header.fromAddress);
  return attempts.some((attempt) => attempt.pending && sentAfter(header, attempt)
    && (employerSender(domain, attempt) || providerSender(domain, attempt)));
}

function postingMatch(text: string, attempt: ApplicationReceiptAttempt): number {
  const requisition = [attempt.sourceUrl, attempt.applicationUrl].some((raw) => {
    const parsed = raw ? URL.parse(raw) : null;
    if (!parsed) return false;
    const explicit = ["gh_jid", "jobId", "requisitionId"].map((key) => parsed.searchParams.get(key));
    const pathId = parsed.pathname.match(/(?:\/|_)((?:R-?|JR-?|REQ-?)?\d{4,})(?=$|[-/])/i)?.[1];
    return [...explicit, pathId].some((value) => value && /^(?:[a-z-]{0,8})?\d{4,}$/i.test(value) && hasPhrase(text, words(value)));
  });
  if (requisition) return 2;
  const title = words(attempt.title);
  return title.length >= 5 && hasPhrase(text, title) ? 1 : 0;
}

export type ReceiptMatch = { attempt: ApplicationReceiptAttempt; result: "confirmed" | "ambiguous" | "truncated"; proofRef: string | null };

export function evaluateSubmissionReceipt(input: {
  header: MailHeader; body: string; uidValidity: string; attempts: ReadonlyArray<ApplicationReceiptAttempt>; truncated?: boolean;
}): ReceiptMatch[] {
  const { header, attempts } = input;
  if (!receiptHeaderRelevant(header, attempts)) return [];
  const raw = `${header.subject}\n${input.body}`;
  if (NON_RECEIPT.test(raw) || !STRICT_RECEIPT.test(raw)) return [];
  const text = words(raw);
  const domain = senderDomain(header.fromAddress);
  const from = words(header.fromName);
  const localPart = header.fromAddress.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const plausible = attempts.filter((attempt) => {
    if (!sentAfter(header, attempt)) return false;
    if (employerSender(domain, attempt)) return true;
    if (!providerSender(domain, attempt)) return false;
    const company = companyKey(attempt.companyName);
    const tenant = [attempt.sourceUrl, attempt.applicationUrl].some((url) => url && atsTenant(url) === localPart);
    return tenant || (company.length >= 3 && (hasPhrase(text, company) || hasPhrase(from, company)));
  }).map((attempt) => ({ attempt, score: postingMatch(text, attempt) })).filter(({ score }) => score > 0);
  const best = Math.max(0, ...plausible.map(({ score }) => score));
  const matched = plausible.filter(({ score }) => score === best).map(({ attempt }) => attempt);
  const result = input.truncated || input.body.length >= 20_000 || Buffer.byteLength(input.body) >= BODY_BYTES ? "truncated" : matched.length === 1 ? "confirmed" : "ambiguous";
  return matched.filter((attempt) => attempt.pending && attempt.runId).map((attempt) => ({
    attempt, result, proofRef: result === "confirmed" ? mailItemKey(header, input.uidValidity) : null
  }));
}

export type ReceiptStore = {
  attempts(): ApplicationReceiptAttempt[];
  record(attempt: ApplicationReceiptAttempt, result: ReceiptResult, proofRef: string | null, at: string): void;
};

export function workspaceReceiptStore(profile: WorkspaceProfile, dataDir: string): ReceiptStore {
  return {
    attempts() {
      try {
        const database = getProfileDatabase(profile);
        refreshApplicationHolds(database, dataDir);
        return listApplicationReceiptAttempts(database);
      } finally { closeProfileDatabase(profile); }
    },
    record(attempt, result, proofRef, at) {
      try { recordApplicationReceipt(getProfileDatabase(profile), attempt, result, proofRef, attempt.attemptedAt, at); }
      finally { closeProfileDatabase(profile); }
    }
  };
}

async function within<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("receipt check timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("receipt check timed out")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

export async function catchUpSubmissionReceipt(input: {
  runId: string; store: ReceiptStore; connect: MailSessionFactory | null; now?: Date;
}): Promise<ReceiptResult | null> {
  const attempts = input.store.attempts();
  const target = attempts.find((attempt) => attempt.pending && attempt.runId === input.runId);
  if (!target) return null;
  const now = input.now ?? new Date();
  const deadline = Date.now() + MAX_CHECK_MS;
  const attemptedAt = Date.parse(target.attemptedAt);
  const earliest = now.getTime() - MAX_DAYS * 86_400_000;
  let result: ReceiptResult = attemptedAt < earliest ? "truncated" : "absent";
  let proof: string | null = null;
  let session: MailSession | undefined;
  try {
    if (!input.connect) throw new Error("receipt mailbox unavailable");
    const connecting = input.connect();
    try { session = await within(connecting, deadline); }
    catch (error) {
      void connecting.then((opened) => opened.close()).catch(() => undefined);
      throw error;
    }
    const uids = await within(session.uidsAfter(0, { since: new Date(Math.max(earliest, attemptedAt)) }), deadline);
    if (uids.length > MAX_UIDS) result = "truncated";
    let bodies = 0;
    const selected = uids.slice(-MAX_UIDS);
    for (let offset = 0; offset < selected.length; offset += 50) {
      const batch = selected.slice(offset, offset + 50);
      const headers = await within(session.headers(batch), deadline);
      if (headers.length !== batch.length) result = "truncated";
      for (const header of headers) {
        if (!receiptHeaderRelevant(header, [target])) continue;
        if (bodies >= MAX_BODIES) { result = "truncated"; break; }
        bodies += 1;
        const { body, truncated } = session.bodyForReceipt
          ? await within(session.bodyForReceipt(header.uid, BODY_BYTES), deadline)
          : { body: await within(session.bodyText(header.uid, BODY_BYTES), deadline), truncated: false };
        if (truncated) result = "truncated";
        const match = evaluateSubmissionReceipt({ header, body, truncated, uidValidity: session.uidValidity, attempts })
          .find(({ attempt }) => attempt.runId === target.runId);
        if (match?.result === "confirmed") { result = "confirmed"; proof = match.proofRef; break; }
        if (match?.result === "ambiguous" && result !== "truncated") result = "ambiguous";
        if (match?.result === "truncated") result = "truncated";
      }
      if (result === "confirmed") break;
    }
  } catch {
    result = "unavailable";
    proof = null;
  } finally {
    if (session) void session.close().catch(() => undefined);
  }
  input.store.record(target, result, proof, now.toISOString());
  return result;
}
