import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Reads the real repository's docs; checks only their shape, never their text.
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const entries = (path) => readdirSync(join(root, path), { withFileTypes: true });

function assertWellFormedFile(path, text) {
  assert.ok(text.length > 0, `${path} is empty`);
  assert.ok(text.endsWith("\n"), `${path} does not end with a newline`);
  assert.ok(!text.endsWith("\n\n"), `${path} ends with a blank line`);
  text.split("\n").forEach((line, index) => assert.doesNotMatch(line, /[ \t]$/, `${path}:${index + 1} ends with a space or tab`));
}

test("BUGS.md only describes the bug folders", () => {
  const lines = read("BUGS.md").split("\n");
  assert.ok(!lines.some((line) => /^#{3,} /.test(line)), "BUGS.md lists a bug");
  assert.deepEqual(lines.filter((line) => /^## /.test(line)), ["## Open", "## Resolved"]);
  assert.ok(lines.includes("`bugs/open/`"));
  assert.ok(lines.includes("`bugs/resolved/`"));
  assert.ok(lines.every((line) => line.length <= 400), "BUGS.md has a line longer than 400 characters");
});

test("TECHNICAL.md lists exactly the topic folders of docs/technical", () => {
  const lines = read("TECHNICAL.md").split("\n");
  const listed = [];
  lines.forEach((line, index) => {
    if (!/^## /.test(line)) return;
    const next = lines.slice(index + 1).find((candidate) => candidate !== "");
    const match = /^`docs\/technical\/([^/`]+)\/`$/.exec(next ?? "");
    assert.ok(match, `"${line}" is not followed by its folder`);
    assert.match(match[1], /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    listed.push(match[1]);
  });
  const folders = entries("docs/technical").filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual(new Set(listed), new Set(folders));
  assert.equal(listed.length, new Set(listed).size);
  assert.ok(lines.every((line) => line.length <= 400), "TECHNICAL.md has a line longer than 400 characters");
});

test("docs/technical holds topic folders of numbered paragraph files", () => {
  for (const folder of entries("docs/technical")) {
    assert.ok(folder.isDirectory(), `docs/technical/${folder.name} is not a folder`);
    for (const file of entries(`docs/technical/${folder.name}`)) {
      const path = `docs/technical/${folder.name}/${file.name}`;
      assert.ok(file.isFile(), `${path} is not a file`);
      assert.match(file.name, /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, path);
      assertWellFormedFile(path, read(path));
    }
  }
});

test("bugs holds one titled file per bug, open or resolved", () => {
  assert.deepEqual(entries("bugs").map((entry) => [entry.name, entry.isDirectory()]).sort(), [["open", true], ["resolved", true]]);
  const names = new Map();
  for (const status of ["open", "resolved"]) {
    for (const file of entries(`bugs/${status}`)) {
      const path = `bugs/${status}/${file.name}`;
      assert.ok(file.isFile(), `${path} is not a file`);
      assert.match(file.name, /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, path);
      assert.ok(!names.has(file.name), `${file.name} is in both bugs/open and bugs/resolved`);
      names.set(file.name, status);
      const text = read(path);
      assertWellFormedFile(path, text);
      const lines = text.split("\n");
      assert.ok(lines[0].startsWith("# "), `${path} does not start with "# <title>"`);
      assert.equal(lines[1], "", `${path} has no blank line after its title`);
      assert.ok(lines.slice(2).some((line) => line !== ""), `${path} has no body`);
      assert.ok(!lines.slice(1).some((line) => line.startsWith("# ")), `${path} has a second title`);
    }
  }
});
