import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_GATE_SLOTS,
  GATE_SLOT_HELD_ENV,
  acquireGateSlot,
  enterGate,
  gateSlotCount,
  gateSlotDirectory,
  gateSlotHolders,
  processStartTime,
  withGateSlot
} from "../support/gate-slots.mjs";

const moduleUrl = new URL("../support/gate-slots.mjs", import.meta.url).href;

// Each test gets its own slot directory, so it never touches the machine's real gate slots.
function slotDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-gate-slots-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const quiet = { log: () => {}, pollMs: 10 };

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function runHolder(directory, body) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import { enterGate } from ${JSON.stringify(moduleUrl)};
    const gate = await enterGate({ label: "test holder", directory: ${JSON.stringify(directory)}, slots: 1, pollMs: 10, log: () => {}, env: {} });
    process.stdout.write("held " + gate.path + "\\n");
    ${body}
  `], { stdio: ["ignore", "pipe", "pipe"] });
}

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (pattern.test(output)) resolve(output);
    });
    child.on("exit", (code) => reject(new Error(`holder exited (${code}) before printing ${pattern}: ${output}`)));
  });
}

function exitOf(child) {
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

test("the slot count defaults to 2 and rejects anything but a whole number from 1 to 32", () => {
  assert.equal(DEFAULT_GATE_SLOTS, 2);
  assert.equal(gateSlotCount({}), 2);
  assert.equal(gateSlotCount({ INTERNSHIP_AGENT_GATE_SLOTS: "" }), 2);
  assert.equal(gateSlotCount({ INTERNSHIP_AGENT_GATE_SLOTS: " 3 " }), 3);
  for (const value of ["0", "33", "-1", "1.5", "two", "unlimited"]) {
    assert.throws(() => gateSlotCount({ INTERNSHIP_AGENT_GATE_SLOTS: value }), /INTERNSHIP_AGENT_GATE_SLOTS must be a whole number/);
  }
});

test("the slot directory is per user in the temp directory, outside the repository", () => {
  const directory = gateSlotDirectory();
  assert.ok(directory.startsWith(tmpdir()));
  assert.match(directory, /internship-agent-gates-/);
  assert.ok(!directory.startsWith(new URL("../../", import.meta.url).pathname));
});

test("a slot is taken and released, and its lock file records the pid and start time", async (t) => {
  const directory = slotDirectory(t);
  const handle = await acquireGateSlot({ directory, slots: 2, label: "unit", ...quiet });
  assert.equal(handle.slot, 1);
  const record = JSON.parse(readFileSync(handle.path, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.equal(record.label, "unit");
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)));
  assert.equal(record.processStart, processStartTime(process.pid));
  assert.deepEqual(gateSlotHolders({ directory, slots: 2 }).map((holder) => holder.pid), [process.pid]);
  handle.release();
  assert.ok(!existsSync(handle.path));
  handle.release();
  assert.deepEqual(gateSlotHolders({ directory, slots: 2 }), []);
});

test("a third waiter is blocked until a slot is released, and says who holds the slots", async (t) => {
  const directory = slotDirectory(t);
  const first = await acquireGateSlot({ directory, slots: 2, ...quiet });
  const second = await acquireGateSlot({ directory, slots: 2, ...quiet });
  assert.deepEqual([first.slot, second.slot], [1, 2]);
  const notices = [];
  let third = null;
  const waiting = acquireGateSlot({ directory, slots: 2, pollMs: 10, noticeMs: 50, log: (line) => notices.push(line) }).then((handle) => { third = handle; });
  await delay(200);
  assert.equal(third, null, "the third waiter took a slot while both were held");
  assert.ok(notices.length >= 2, "the waiter printed no repeated waiting line");
  assert.equal(notices[0], `waiting for a gate slot: 2 in use by pids ${process.pid}, ${process.pid}`);
  first.release();
  await waiting;
  assert.equal(third.slot, 1);
  second.release();
  third.release();
});

test("a slot left by a dead pid is reclaimed", async (t) => {
  const directory = slotDirectory(t);
  const pid = deadPid();
  writeFileSync(join(directory, "slot-1.lock"), JSON.stringify({ pid, processStart: null, startedAt: new Date().toISOString(), token: "dead" }));
  assert.deepEqual(gateSlotHolders({ directory, slots: 1 }), []);
  const handle = await acquireGateSlot({ directory, slots: 1, ...quiet });
  assert.equal(handle.slot, 1);
  assert.equal(JSON.parse(readFileSync(handle.path, "utf8")).pid, process.pid);
  handle.release();
});

test("a slot whose pid now names another process is reclaimed", { skip: processStartTime(process.pid) === null && "needs /proc" }, async (t) => {
  const directory = slotDirectory(t);
  writeFileSync(join(directory, "slot-1.lock"), JSON.stringify({ pid: process.pid, processStart: "0", startedAt: new Date().toISOString(), token: "reused" }));
  const handle = await acquireGateSlot({ directory, slots: 1, ...quiet });
  assert.equal(JSON.parse(readFileSync(handle.path, "utf8")).token === "reused", false);
  handle.release();
});

test("a live holder's slot is never reclaimed", async (t) => {
  const directory = slotDirectory(t);
  const held = await acquireGateSlot({ directory, slots: 1, ...quiet });
  const before = readFileSync(held.path, "utf8");
  let taken = false;
  const waiting = acquireGateSlot({ directory, slots: 1, ...quiet }).then((handle) => { taken = true; return handle; });
  await delay(100);
  assert.equal(taken, false);
  assert.equal(readFileSync(held.path, "utf8"), before);
  held.release();
  (await waiting).release();
});

test("the slot is released when the work throws", async (t) => {
  const directory = slotDirectory(t);
  let path = null;
  await assert.rejects(withGateSlot({ directory, slots: 1, ...quiet }, async (handle) => {
    path = handle.path;
    assert.ok(existsSync(path));
    throw new Error("gate step failed");
  }), /gate step failed/);
  assert.ok(!existsSync(path));
  const next = await acquireGateSlot({ directory, slots: 1, ...quiet });
  assert.equal(next.slot, 1);
  next.release();
});

test("a gate process releases its slot on an uncaught error and on SIGTERM", async (t) => {
  const directory = slotDirectory(t);
  const thrower = runHolder(directory, `throw new Error("uncaught in gate");`);
  thrower.stderr.resume();
  const thrown = await exitOf(thrower);
  assert.equal(thrown.code, 1);
  assert.ok(!existsSync(join(directory, "slot-1.lock")), "the slot outlived an uncaught error");

  const sleeper = runHolder(directory, `setInterval(() => {}, 1000);`);
  sleeper.stderr.resume();
  await waitForLine(sleeper, /held /);
  assert.ok(existsSync(join(directory, "slot-1.lock")));
  const exited = exitOf(sleeper);
  sleeper.kill("SIGTERM");
  assert.equal((await exited).code, 143);
  assert.ok(!existsSync(join(directory, "slot-1.lock")), "the slot outlived SIGTERM");
});

test("a gate whose parent holds a slot, or run with --no-wait, takes no slot", async (t) => {
  const directory = slotDirectory(t);
  const nested = await enterGate({ label: "nested", directory, slots: 1, ...quiet, env: { [GATE_SLOT_HELD_ENV]: "/parent/slot-1.lock" } });
  assert.equal(nested.slot, null);
  const lines = [];
  const skipped = await enterGate({ label: "skipped", directory, slots: 1, pollMs: 10, log: (line) => lines.push(line), noWait: true, env: {} });
  assert.equal(skipped.slot, null);
  assert.match(lines[0], /--no-wait: running without a gate slot/);
  assert.deepEqual(gateSlotHolders({ directory, slots: 1 }), []);
  const held = await enterGate({ label: "held", directory, slots: 1, ...quiet, env: {} });
  assert.equal(held.slot, 1);
  assert.equal(held.env[GATE_SLOT_HELD_ENV], held.path);
  held.release();
  assert.ok(!existsSync(held.path));
});
