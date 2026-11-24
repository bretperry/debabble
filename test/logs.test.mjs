// Tests for src/logs.mjs: log folder layout, modes, unique names, and pruning by count and age.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/logs.mjs.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MAX_AGE_DAYS, MAX_LOGS, logBase, logDirFor, openLog, pruneLogs, slug } from "../src/logs.mjs";
import { tmp } from "./helpers.mjs";

const DAY = 24 * 60 * 60 * 1000;
// Writes a log named like ours with a modified time `ageMs` before `now`.
const plant = (dir, name, now, ageMs) => {
  const file = join(dir, name);
  writeFileSync(file, "x");
  const at = new Date(now - ageMs);
  utimesSync(file, at, at);
};
const name = (i) => `20261101-0000${String(i % 60).padStart(2, "0")}-run-${i}.log`;

describe("log folder", () => {
  it("base: --log-dir wins over DEBABBLE_LOG_DIR, which wins over XDG_STATE_HOME, which wins over ~/.local/state", () => {
    assert.equal(logBase({ DEBABBLE_LOG_DIR: "/a" }, "/f"), "/f");
    assert.equal(logBase({ DEBABBLE_LOG_DIR: "/a", XDG_STATE_HOME: "/x" }), "/a");
    assert.equal(logBase({ XDG_STATE_HOME: "/x" }), "/x/debabble");
    assert.equal(logBase({}), join(homedir(), ".local", "state", "debabble"));
    assert.equal(logBase({ DEBABBLE_LOG_DIR: "" }), join(homedir(), ".local", "state", "debabble"));
  });

  it("the folder is <repo-basename>-<4 hex>, and two folders named alike differ", () => {
    const base = tmp("base");
    const [a, b] = [join(tmp("p"), "app"), join(tmp("q"), "app")];
    mkdirSync(a);
    mkdirSync(b);
    const [da, db] = [logDirFor(a, { DEBABBLE_LOG_DIR: base }), logDirFor(b, { DEBABBLE_LOG_DIR: base })];
    assert.match(da, /\/app-[0-9a-f]{4}$/);
    assert.notEqual(da, db);
  });

  it("slug keeps names safe and short", () => {
    assert.equal(slug("pnpm test run x"), "pnpm-test-run-x");
    assert.doesNotMatch(slug("../../etc/passwd"), /[\/]/);
    assert.equal(slug("   "), "run");
    assert.ok(slug("x".repeat(300)).length <= 60);
  });

  it("makes the folder 0700 and each log 0600, and two logs in one second never share a file", () => {
    const dir = join(tmp("base"), "repo-0000");
    const now = Date.UTC(2026, 10, 21, 14, 22, 1);
    const first = openLog(dir, "pnpm test", { now });
    const second = openLog(dir, "pnpm test", { now });
    assert.notEqual(first.logFile, second.logFile);
    assert.match(second.logFile, /-pnpm-test-2\.log$/);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const { logFile } of [first, second]) assert.equal(statSync(logFile).mode & 0o777, 0o600);
  });

  it("a folder it can't use: says which and why, and reuses one fallback folder per user, pruned like any other", () => {
    const blocker = join(tmp("base"), "a-file");
    writeFileSync(blocker, "");
    const dir = join(blocker, "repo-0000");
    const spare = tmp("tmp");
    const now = Date.UTC(2026, 10, 21, 14, 22, 1);
    const first = openLog(dir, "one", { now, tmp: spare });
    assert.deepEqual(first.fallback, { dir, error: "ENOTDIR" });
    assert.equal(first.dir, join(spare, `debabble-${process.getuid()}`));
    assert.equal(statSync(first.dir).mode & 0o777, 0o700);
    plant(first.dir, name(1), now, (MAX_AGE_DAYS + 1) * DAY);
    const second = openLog(dir, "two", { now, tmp: spare });
    assert.equal(second.dir, first.dir);
    assert.deepEqual(readdirSync(spare), [`debabble-${process.getuid()}`]);
    assert.equal(existsSync(join(first.dir, name(1))), false, "the old log in the fallback folder was pruned");
    assert.equal(openLog(join(tmp("ok"), "repo-0000"), "fine", { now, tmp: spare }).fallback, null);
  });

  it("a fallback folder someone planted as a link: a fresh private folder instead", () => {
    const blocker = join(tmp("base"), "a-file");
    writeFileSync(blocker, "");
    const spare = tmp("tmp");
    symlinkSync(tmp("elsewhere"), join(spare, `debabble-${process.getuid()}`));
    const opened = openLog(join(blocker, "repo-0000"), "x", { tmp: spare });
    assert.notEqual(opened.dir, join(spare, `debabble-${process.getuid()}`));
    assert.ok(opened.dir.startsWith(join(spare, "debabble-")));
    assert.notEqual(opened.fallback, null);
  });

  it("tightens a folder that exists with looser modes", () => {
    const dir = join(tmp("base"), "repo-0000");
    mkdirSync(dir, { mode: 0o755 });
    openLog(dir, "x");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("a folder that is a symlink is refused, and the log goes to a private temp folder instead", () => {
    const base = tmp("base");
    const target = tmp("elsewhere");
    const dir = join(base, "repo-0000");
    symlinkSync(target, dir);
    const { logFile } = openLog(dir, "x");
    assert.equal(readdirSync(target).length, 0);
    assert.equal(existsSync(logFile), true);
    assert.ok(!logFile.startsWith(dir));
  });
});

describe("pruning", () => {
  it("removes logs older than MAX_AGE_DAYS and keeps newer ones", () => {
    const dir = tmp("prune");
    const now = Date.now();
    plant(dir, name(1), now, (MAX_AGE_DAYS + 1) * DAY);
    plant(dir, name(2), now, (MAX_AGE_DAYS - 1) * DAY);
    assert.equal(pruneLogs(dir, { now }), 1);
    assert.deepEqual(readdirSync(dir), [name(2)]);
  });

  it("keeps room for the run about to start: at most MAX_LOGS - 1 remain, the oldest go first", () => {
    const dir = tmp("prune");
    const now = Date.now();
    for (let i = 0; i < MAX_LOGS + 5; i += 1) plant(dir, name(i), now, 1000 + (MAX_LOGS + 5 - i) * 1000);
    pruneLogs(dir, { now });
    const left = readdirSync(dir);
    assert.equal(left.length, MAX_LOGS - 1);
    assert.equal(left.includes(name(0)), false, "the oldest is gone");
    assert.equal(left.includes(name(MAX_LOGS + 4)), true, "the newest stays");
  });

  it("only touches files named like its own logs", () => {
    const dir = tmp("prune");
    const now = Date.now();
    plant(dir, "notes.txt", now, 30 * DAY);
    plant(dir, "20261101-000000.log", now, 30 * DAY);
    mkdirSync(join(dir, "20261101-000000-dir.log"));
    assert.equal(pruneLogs(dir, { now }), 0);
    assert.equal(readdirSync(dir).length, 3);
  });

  it("openLog prunes before it creates, so 205 old logs and a new run leave MAX_LOGS", () => {
    const dir = tmp("prune");
    const now = Date.now();
    for (let i = 0; i < 205; i += 1) plant(dir, name(i), now, 1000 + i);
    openLog(dir, "new", { now });
    assert.equal(readdirSync(dir).length, MAX_LOGS);
  });

  it("a missing folder is nothing to prune", () => {
    assert.equal(pruneLogs(join(tmp("none"), "absent")), 0);
  });
});
