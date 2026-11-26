import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * A machine-wide counting semaphore for heavy verification gates
 * (`agent:finish` and browser-tier suites run by the harness runner).
 * Parallel worktrees on one machine share the slot directory, so it lives
 * in the per-user temp directory, never in a repository. Each slot is one
 * lock file, created atomically with link(2) so it is never seen half
 * written, holding the owner's pid and process start time. A slot whose
 * owner is gone (dead pid, or the pid reused by another process) is
 * reclaimed.
 */

export const GATE_SLOTS_ENV = "INTERNSHIP_AGENT_GATE_SLOTS";
/** Set for a gate's children, so a nested runner uses its parent's slot instead of taking a second one. */
export const GATE_SLOT_HELD_ENV = "INTERNSHIP_AGENT_GATE_SLOT_HELD";
export const DEFAULT_GATE_SLOTS = 2;
export const MAX_GATE_SLOTS = 32;
export const GATE_WAIT_NOTICE_MS = 30_000;
const GATE_POLL_MS = 1_000;
// A reclaim lock is held only for a read and an unlink; one this old was left by a crashed reclaimer.
const RECLAIM_LOCK_STALE_MS = 10_000;

export function gateSlotDirectory() {
  const owner = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `internship-agent-gates-${owner}`);
}

export function gateSlotCount(env = process.env) {
  const raw = env[GATE_SLOTS_ENV]?.trim();
  if (!raw) return DEFAULT_GATE_SLOTS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_GATE_SLOTS) {
    throw new Error(`${GATE_SLOTS_ENV} must be a whole number from 1 to ${MAX_GATE_SLOTS} (got "${raw}").`);
  }
  return value;
}

function slotPath(directory, slot) {
  return join(directory, `slot-${slot}.lock`);
}

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) throw new Error(`Gate slot path ${directory} is not a directory.`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`Gate slot directory ${directory} belongs to another user.`);
  }
}

/** Linux only: field 22 of /proc/<pid>/stat (start time in clock ticks since boot), or null. */
export function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseHolder(raw) {
  try {
    const holder = JSON.parse(raw);
    return holder && typeof holder === "object" ? holder : null;
  } catch {
    return null;
  }
}

/** A holder is stale when its record is unreadable, its pid is dead, or its pid now names a different process. */
export function holderIsStale(holder) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return true;
  if (!processIsAlive(holder.pid)) return true;
  if (typeof holder.processStart === "string") {
    const current = processStartTime(holder.pid);
    if (current !== null && current !== holder.processStart) return true;
  }
  return false;
}

// Removes a stale slot file only while holding the slot's reclaim lock and
// only if the file still holds the record judged stale, so two reclaimers
// never delete a slot a third process has just taken.
function reclaim(path, observedRaw) {
  const lock = `${path}.reclaim`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs > RECLAIM_LOCK_STALE_MS) rmdirSync(lock);
    } catch {
      // Another reclaimer finished first.
    }
    return false;
  }
  try {
    const raw = readRaw(path);
    if (raw === null) return true;
    if (raw !== observedRaw) return false;
    unlinkSync(path);
    return true;
  } finally {
    try { rmdirSync(lock); } catch { /* Already removed as stale by another reclaimer. */ }
  }
}

function tryTake(directory, slots, record) {
  const pending = join(directory, `.pending-${process.pid}-${randomUUID()}`);
  writeFileSync(pending, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    for (let slot = 1; slot <= slots; slot += 1) {
      const path = slotPath(directory, slot);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          linkSync(pending, path);
          return { slot, path };
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        const raw = readRaw(path);
        if (raw !== null && !(holderIsStale(parseHolder(raw)) && reclaim(path, raw))) break;
      }
    }
    return null;
  } finally {
    try { unlinkSync(pending); } catch { /* Already gone. */ }
  }
}

/** The live holders of the first `slots` slots. */
export function gateSlotHolders({ directory = gateSlotDirectory(), slots = gateSlotCount() } = {}) {
  const holders = [];
  for (let slot = 1; slot <= slots; slot += 1) {
    const raw = readRaw(slotPath(directory, slot));
    const holder = raw === null ? null : parseHolder(raw);
    if (holder && !holderIsStale(holder)) holders.push({ slot, ...holder });
  }
  return holders;
}

/**
 * Waits for a free slot (no timeout) and takes it. Prints one waiting line
 * at once and then every `noticeMs`. Returns a handle whose `release()` is
 * idempotent and removes the slot only while it still holds this record.
 */
export async function acquireGateSlot({
  directory = gateSlotDirectory(),
  slots = gateSlotCount(),
  label = "gate",
  pollMs = GATE_POLL_MS,
  noticeMs = GATE_WAIT_NOTICE_MS,
  log = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  ensureDirectory(directory);
  const record = {
    pid: process.pid,
    processStart: processStartTime(process.pid),
    startedAt: new Date().toISOString(),
    label,
    cwd: process.cwd(),
    token: randomUUID()
  };
  let lastNotice = Number.NEGATIVE_INFINITY;
  for (;;) {
    const taken = tryTake(directory, slots, record);
    if (taken) return slotHandle(taken, slots, record);
    if (Date.now() - lastNotice >= noticeMs) {
      const pids = gateSlotHolders({ directory, slots }).map((holder) => holder.pid);
      log(`waiting for a gate slot: ${pids.length} in use by pids ${pids.join(", ") || "(releasing)"}`);
      lastNotice = Date.now();
    }
    await delay(pollMs);
  }
}

function slotHandle({ slot, path }, slots, record) {
  let released = false;
  return {
    slot,
    slots,
    path,
    pid: record.pid,
    release() {
      if (released) return;
      released = true;
      const holder = parseHolder(readRaw(path) ?? "");
      if (holder?.token === record.token) {
        try { unlinkSync(path); } catch { /* Already gone. */ }
      }
    }
  };
}

/** Holds a slot for `work` and releases it whether `work` resolves or throws. */
export async function withGateSlot(options, work) {
  const handle = await acquireGateSlot(options);
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}

/**
 * Enters a gate for a command-line process. A process whose parent already
 * holds a slot (`INTERNSHIP_AGENT_GATE_SLOT_HELD`) and `--no-wait` take no
 * slot. Otherwise it waits for one and releases it on exit, on an uncaught
 * error, and on SIGINT or SIGTERM (calling `onSignal` first, to stop the
 * running child, then exiting with 128 + the signal number). `env` is the
 * environment for the gate's children.
 */
export async function enterGate({ label, noWait = false, env = process.env, prefix = "[gate]", onSignal = () => {}, log, ...options }) {
  const write = log ?? ((line) => process.stdout.write(`${line}\n`));
  if (env[GATE_SLOT_HELD_ENV]) return { slot: null, env, release() {} };
  if (noWait) {
    write(`${prefix} --no-wait: running without a gate slot`);
    return { slot: null, env, release() {} };
  }
  const handle = await acquireGateSlot({ label, log: (line) => write(`${prefix} ${line}`), ...options });
  write(`${prefix} gate slot ${handle.slot} of ${handle.slots} taken by pid ${handle.pid}`);
  const onExit = () => handle.release();
  const onSignalReceived = (signal) => {
    try { onSignal(signal); } finally {
      release();
      process.exit(128 + (constants.signals[signal] ?? 1));
    }
  };
  function release() {
    process.off("exit", onExit);
    process.off("SIGINT", onSignalReceived);
    process.off("SIGTERM", onSignalReceived);
    handle.release();
  }
  process.on("exit", onExit);
  process.on("SIGINT", onSignalReceived);
  process.on("SIGTERM", onSignalReceived);
  return { slot: handle.slot, path: handle.path, env: { ...env, [GATE_SLOT_HELD_ENV]: handle.path }, release };
}
