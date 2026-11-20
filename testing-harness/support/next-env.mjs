import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * `next dev` and `next build` rewrite the tracked apps/dashboard/next-env.d.ts
 * to import route types from their own output directory. Harness commands
 * snapshot the file first and put it back afterwards, so verification never
 * leaves churn in the working tree. Returns a restore function that reports
 * whether the file matches the snapshot again.
 */
export function preserveNextEnv() {
  const path = new URL("../../apps/dashboard/next-env.d.ts", import.meta.url);
  const snapshot = existsSync(path) ? readFileSync(path, "utf8") : null;
  return function restoreNextEnv() {
    if (snapshot === null) {
      rmSync(path, { force: true });
      return true;
    }
    if (!existsSync(path) || readFileSync(path, "utf8") !== snapshot) writeFileSync(path, snapshot);
    return readFileSync(path, "utf8") === snapshot;
  };
}
