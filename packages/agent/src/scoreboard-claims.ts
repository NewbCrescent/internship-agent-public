import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { acquireApplicationHoldDeliveryLock } from "@internship-agent/db";

import { redactNoticeText } from "./pass-notice";

/**
 * Blocker claims for the application scoreboard: a fix track leases one blocker at a time
 * (one claim per track), renews the lease by claiming again, and gives a reason when it
 * releases it. A claim with no renewal for CLAIM_STALE_HOURS is stale and another track may
 * take it over. The claims file lives next to the scoreboard snapshots, owner-only.
 */

export const CLAIM_STALE_HOURS = 24;
const HISTORY_RETENTION_DAYS = 30;
const HOUR_MS = 3_600_000;
const BLOCKER_ID = /^b[0-9a-f]{10}$/;
const TRACK = /^[A-Za-z0-9 ._-]{1,40}$/;

export function scoreboardDirectory(dataDir: string): string {
  return join(dataDir, "scoreboard");
}

export function scoreboardClaimsPath(dataDir: string): string {
  return join(scoreboardDirectory(dataDir), "claims.json");
}

const claimSchema = z.object({
  id: z.string(), label: z.string(), track: z.string(), claimedAt: z.iso.datetime(), renewedAt: z.iso.datetime()
});
const historySchema = z.object({
  id: z.string(), label: z.string(), track: z.string(), event: z.enum(["released", "done", "expired"]),
  reason: z.string().nullable(), at: z.iso.datetime()
});
const claimsFileSchema = z.object({ version: z.literal(1), claims: z.array(claimSchema), history: z.array(historySchema) });

export type ScoreboardClaim = z.infer<typeof claimSchema>;
export type ScoreboardClaimHistory = z.infer<typeof historySchema>;
export type ScoreboardClaims = z.infer<typeof claimsFileSchema>;

const empty = (): ScoreboardClaims => ({ version: 1, claims: [], history: [] });

/** The claims file; a missing or damaged file reads as no claims. */
export function readScoreboardClaims(dataDir: string): ScoreboardClaims {
  try {
    const parsed = claimsFileSchema.safeParse(JSON.parse(readFileSync(scoreboardClaimsPath(dataDir), "utf8")));
    return parsed.success ? parsed.data : empty();
  } catch {
    return empty();
  }
}

export function claimIsStale(claim: Pick<ScoreboardClaim, "renewedAt">, now: Date): boolean {
  return now.getTime() - Date.parse(claim.renewedAt) > CLAIM_STALE_HOURS * HOUR_MS;
}

export function claimAgeHours(claim: Pick<ScoreboardClaim, "renewedAt">, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(claim.renewedAt)) / HOUR_MS));
}

export type ClaimResult = { ok: true; message: string } | { ok: false; message: string };
export type ClaimBlockerResult = { ok: true; renewed: boolean; tookOver: string | null; message: string } | { ok: false; message: string };

function ensureDirectory(dataDir: string): string {
  const directory = scoreboardDirectory(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function writeClaims(dataDir: string, claims: ScoreboardClaims, now: Date): void {
  const cutoff = now.getTime() - HISTORY_RETENTION_DAYS * 24 * HOUR_MS;
  const kept: ScoreboardClaims = { ...claims, history: claims.history.filter((entry) => Date.parse(entry.at) >= cutoff) };
  const path = scoreboardClaimsPath(dataDir);
  writeFileSync(path + ".tmp", JSON.stringify(kept, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path + ".tmp", 0o600);
  renameSync(path + ".tmp", path);
}

/** Runs one read-change-write of the claims file under a lock, so two claim commands never interleave. */
function withClaims<R extends ClaimResult | ClaimBlockerResult>(
  dataDir: string, change: (claims: ScoreboardClaims) => R & { write?: ScoreboardClaims }, now: Date
): R | { ok: false; message: string } {
  const directory = ensureDirectory(dataDir);
  const release = acquireApplicationHoldDeliveryLock(join(directory, ".claims-lock.sqlite"));
  if (!release) return { ok: false, message: "Another claim command is running; try again." };
  try {
    const { write, ...result } = change(readScoreboardClaims(dataDir));
    if (result.ok && write) writeClaims(dataDir, write, now);
    return result as R;
  } finally {
    release();
  }
}

function validId(id: string): string | null {
  return BLOCKER_ID.test(id) ? null : `"${id.slice(0, 40)}" is not a blocker id (b followed by 10 hex characters).`;
}

export function claimBlocker(dataDir: string, input: { id: string; label: string; track: string }, now: Date): ClaimBlockerResult {
  const idError = validId(input.id);
  if (idError) return { ok: false, message: idError };
  const track = input.track.trim();
  if (!TRACK.test(track)) return { ok: false, message: "The track must be 1 to 40 letters, digits, spaces, dots, dashes, or underscores." };
  const at = now.toISOString();
  return withClaims<ClaimBlockerResult>(dataDir, (claims) => {
    const current = claims.claims.find((claim) => claim.id === input.id);
    if (current && current.track === track) {
      return {
        ok: true, renewed: true, tookOver: null, message: `Renewed ${input.id} for ${track}: ${current.label}`,
        write: { ...claims, claims: claims.claims.map((claim) => claim.id === input.id ? { ...claim, renewedAt: at } : claim) }
      };
    }
    if (current && !claimIsStale(current, now)) {
      return { ok: false, message: `${input.id} is claimed by ${current.track} (${claimAgeHours(current, now)}h since its last renewal).` };
    }
    const other = claims.claims.find((claim) => claim.track === track && claim.id !== input.id && !claimIsStale(claim, now));
    if (other) {
      return { ok: false, message: `${track} already holds ${other.id}; release it with a reason or mark it done first.` };
    }
    // A track's own stale claims on other blockers lapse when it claims a new one.
    const lapsed = claims.claims.filter((claim) => claim.id === input.id || (claim.track === track && claimIsStale(claim, now)));
    const history = [...claims.history, ...lapsed.map((claim) => ({
      id: claim.id, label: claim.label, track: claim.track, event: "expired" as const, reason: null, at
    }))];
    const kept = claims.claims.filter((claim) => !lapsed.includes(claim));
    const message = current
      ? `Took over stale claim from ${current.track}: claimed ${input.id} for ${track}: ${input.label}`
      : `Claimed ${input.id} for ${track}: ${input.label}`;
    return {
      ok: true, renewed: false, tookOver: current?.track ?? null, message,
      write: { ...claims, claims: [...kept, { id: input.id, label: input.label, track, claimedAt: at, renewedAt: at }], history }
    };
  }, now);
}

export function releaseBlocker(dataDir: string, input: { id: string; reason: string }, now: Date): ClaimResult {
  const idError = validId(input.id);
  if (idError) return { ok: false, message: idError };
  const reason = redactNoticeText(input.reason.trim());
  if (reason.length < 1 || reason.length > 300) return { ok: false, message: "A release needs a reason of 1 to 300 characters." };
  return withClaims<ClaimResult>(dataDir, (claims) => {
    const current = claims.claims.find((claim) => claim.id === input.id);
    if (!current) return { ok: false, message: `No claim on ${input.id}.` };
    return {
      ok: true, message: `Released ${input.id} (${current.track}): ${reason}`,
      write: {
        ...claims, claims: claims.claims.filter((claim) => claim !== current),
        history: [...claims.history, { id: current.id, label: current.label, track: current.track, event: "released", reason, at: now.toISOString() }]
      }
    };
  }, now);
}

export function finishBlocker(dataDir: string, input: { id: string }, now: Date): ClaimResult {
  const idError = validId(input.id);
  if (idError) return { ok: false, message: idError };
  return withClaims<ClaimResult>(dataDir, (claims) => {
    const current = claims.claims.find((claim) => claim.id === input.id);
    if (!current) return { ok: false, message: `No claim on ${input.id}.` };
    return {
      ok: true, message: `Marked ${input.id} done (${current.track}): ${current.label}`,
      write: {
        ...claims, claims: claims.claims.filter((claim) => claim !== current),
        history: [...claims.history, { id: current.id, label: current.label, track: current.track, event: "done", reason: null, at: now.toISOString() }]
      }
    };
  }, now);
}
