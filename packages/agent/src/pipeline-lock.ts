import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

/**
 * Marks a running `pnpm pipeline:run` for one workspace. While it is held,
 * the dashboard refuses board checks (they would compete for the same model
 * rate limit) and a second pipeline run refuses to start. A lock whose
 * process has exited is stale and ignored, so a crash never blocks forever.
 */
export type PipelineLock = { pid: number; startedAt: string };

const lockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.iso.datetime() });
const LOCK_FILE = "pipeline.lock";

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The active lock for this workspace, or null when none is held (or it is stale). */
export function readPipelineLock(dataDir: string): PipelineLock | null {
  try {
    const lock = lockSchema.parse(JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as unknown);
    return isAlive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** Takes the lock or throws when another live run holds it; returns the release function. */
export function acquirePipelineLock(dataDir: string, pid: number = process.pid): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);
  const lock: PipelineLock = { pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" creates atomically: only one process can win the lock file.
      writeFileSync(path, JSON.stringify(lock), { flag: "wx" });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readPipelineLock(dataDir)?.pid === pid) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = readPipelineLock(dataDir);
      if (held) throw new Error(`A pipeline run is already in progress (process ${held.pid}, started ${held.startedAt}).`);
      rmSync(path, { force: true }); // stale: its process has exited
    }
  }
  throw new Error("The pipeline lock could not be taken.");
}
