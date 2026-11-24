// Tests for src/run.mjs: the log gets both streams in order, and a command that outlives its limit is stopped with what it started.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/run.mjs, and bin/debabble.mjs (through test/helpers.mjs) for the redaction cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "../src/run.mjs";
import { cli, logPathOf, tmp } from "./helpers.mjs";

const logIn = (root) => {
  const file = join(root, "x.log");
  writeFileSync(file, "");
  return file;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("run", () => {
  it("reports an exit code as is", async () => {
    const root = tmp();
    const ran = await run({ command: process.execPath, args: ["-e", "process.exit(3)"], cwd: root, logFile: logIn(root) });
    assert.deepEqual([ran.status, ran.signal, ran.timedOut, ran.error], [3, null, false, undefined]);
  });

  it("reports a command stopped by a signal as that signal", async () => {
    const root = tmp();
    const ran = await run({ command: process.execPath, args: ["-e", "console.log('x'); process.kill(process.pid, 'SIGKILL')"], cwd: root, logFile: logIn(root) });
    assert.deepEqual([ran.status, ran.signal, ran.timedOut], [null, "SIGKILL", false]);
  });

  it("reports a command that does not exist as an error with its code", async () => {
    const root = tmp();
    const ran = await run({ command: "debabble-no-such-command", cwd: root, logFile: logIn(root) });
    assert.equal(ran.error?.code, "ENOENT");
  });

  it("stops a command that outlives its limit, along with what it started, and says it timed out", async () => {
    const root = tmp();
    const marker = join(root, "grandchild.pid");
    const source = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(g.pid)); console.log('started'); setTimeout(() => {}, 60000);`;
    const ran = await run({ command: process.execPath, args: ["-e", source], cwd: root, logFile: logIn(root), timeoutMs: 1500 });
    assert.equal(ran.timedOut, true);
    assert.ok(ran.ms < 20_000, `did not wait for the command (${ran.ms} ms)`);
    assert.equal(existsSync(marker), true, "the grandchild started");
    const pid = Number(readFileSync(marker, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(pid), false, "the grandchild is gone too");
  });

  it("the log keeps fd 1 and fd 2 in the order the command wrote them (3000 alternating writes)", async () => {
    const root = tmp();
    const logFile = logIn(root);
    const source = "const { writeSync } = require('node:fs'); for (let i = 0; i < 3000; i++) writeSync(i % 2 ? 2 : 1, 'line ' + i + '\\n'); process.exit(1);";
    const ran = await run({ command: process.execPath, args: ["-e", source], cwd: root, logFile });
    assert.equal(ran.status, 1);
    assert.deepEqual(readFileSync(logFile, "utf8").trimEnd().split("\n"), Array.from({ length: 3000 }, (_, i) => `line ${i}`));
  });

  it("works under a path with spaces", async () => {
    const root = tmp("a b");
    const logFile = logIn(root);
    const ran = await run({ command: process.execPath, args: ["-e", "console.log(process.cwd())"], cwd: root, logFile });
    assert.equal(ran.status, 0);
    assert.ok(statSync(logFile).size > 0);
  });

  it("loses nothing from a command that writes 8 MB, a 3 MB line, then calls process.exit", async () => {
    const root = tmp();
    const logFile = logIn(root);
    const source = "const { writeSync } = require('node:fs'); for (let i = 0; i < 50000; i++) writeSync(i % 2 ? 2 : 1, 'filler ' + i + ' ' + 'x'.repeat(90) + '\\n'); writeSync(1, 'y'.repeat(3000000)); writeSync(2, '\\nlast line\\n'); process.exit(1);";
    await run({ command: process.execPath, args: ["-e", source], cwd: root, logFile });
    assert.ok(statSync(logFile).size > 7_500_000);
    assert.ok(readFileSync(logFile, "utf8").endsWith("last line\n"));
  });
});

// The command builds its secrets at run time from pieces, so no secret-shaped literal sits in this file or in the command line the test passes.
const SECRET_SOURCE = `
const gh = 'gh' + 'p_' + 'A'.repeat(36);
const jwt = ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0NTYifQ', 'SflKxwRJSMeKKF2QT4fwpM'].join('.');
const d = '-'.repeat(5);
const pem = [d + 'BEGIN RSA PRIVATE KEY' + d, 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn', 'Zm9vYmFyYmF6cXV4', d + 'END RSA PRIVATE KEY' + d].join('\\n');
console.log('Error: auth failed with ' + gh);
console.log('retrying https://alice:hunter2@example.com/x with ' + jwt);
console.log(pem);
console.error('FAIL aws key ' + 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP');
process.exit(1);
`;
const SECRETS = ["gh" + "p_" + "A".repeat(36), "alice:hunter2", "SflKxwRJSMeKKF2QT4fwpM", "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn", "Zm9vYmFyYmF6cXV4", "AK" + "IA" + "ABCDEFGHIJKLMNOP"];

describe("redaction on print (cli)", () => {
  it("masks the excerpt of a red run, and the log keeps the command's bytes exactly", () => {
    const result = cli(["--", process.execPath, "-e", SECRET_SOURCE]);
    assert.equal(result.status, 1, result.stderr);
    for (const secret of SECRETS) assert.equal(result.stdout.includes(secret), false, `printed ${secret}`);
    for (const shape of ["github-token", "url-credentials", "jwt", "pem-private-key", "aws-access-key"]) assert.match(result.stdout, new RegExp(`<redacted:${shape}>`));
    assert.match(result.stdout, /Error: auth failed with <redacted:github-token>/);
    const raw = run_raw(SECRET_SOURCE);
    const log = readFileSync(logPathOf(result.stdout));
    assert.deepEqual(log, raw, "the log is byte-identical to what the command wrote");
    for (const secret of SECRETS) assert.equal(log.includes(secret), true, `the log lost ${secret}`);
    assert.equal(statSync(logPathOf(result.stdout)).mode & 0o777, 0o600);
  });

  it("masks the verdict line of a green run (first error-like line) and the excerpt of --show excerpt", () => {
    const source = "console.log('Error: tolerated ' + 'gh' + 'p_' + 'B'.repeat(30)); console.log('warning: ' + 'https://u:pw@h/')";
    const verdict = cli(["--", process.execPath, "-e", source]);
    assert.equal(verdict.status, 0, verdict.stderr);
    assert.match(verdict.lines.at(-1), /1 error-like line: "Error: tolerated <redacted:github-token>"/);
    assert.match(verdict.lines.at(-1), /1 warning: "warning: https:\/\/<redacted:url-credentials>@h\/"/);
    assert.doesNotMatch(verdict.stdout, /BBBB|u:pw/);
    const excerpt = cli(["--show", "excerpt", "--", process.execPath, "-e", source]);
    assert.match(excerpt.stdout, /  Error: tolerated <redacted:github-token>/);
    assert.doesNotMatch(excerpt.stdout, /BBBB/);
    assert.equal(readFileSync(logPathOf(excerpt.stdout), "utf8").includes("B".repeat(30)), true);
  });

  it("masks a secret in the label and in the log's file name, and masks a PEM key the excerpt cuts into", () => {
    const label = "curl https://bob:" + "s3cr3t" + "@example.com";
    const result = cli(["--label", label, "--", process.execPath, "-e", "process.exit(2)"]);
    assert.doesNotMatch(result.stdout, /s3cr3t|bob:/);
    assert.match(result.lines[1], /^✗ curl https:\/\/<redacted:url-credentials>@example\.com · exit 2/);
    assert.doesNotMatch(logPathOf(result.stdout), /s3cr3t|bob/);
    // 200 filler lines, then a key whose BEGIN line is far above the tail: the tail shows only key body lines.
    const key = "const d = '-'.repeat(5); const k = [d + 'BEGIN PRIVATE KEY' + d, ...Array.from({ length: 40 }, (_, i) => 'QUJDREVG' + String(1000 + i)), d + 'END PRIVATE KEY' + d];";
    const cut = cli(["--", process.execPath, "-e", `${key} console.log('Error: x'); for (let i = 0; i < 50; i++) console.log('filler ' + i); console.log(k.join('\\n')); process.exit(1)`]);
    assert.doesNotMatch(cut.stdout, /QUJDREVG/);
    assert.match(cut.stdout, /<redacted:pem-private-key>/);
  });

  it("prints ordinary output unchanged", () => {
    const result = cli(["--", process.execPath, "-e", "console.log('Error: secret=changeme token: abc see https://example.com:8080/a@b'); process.exit(1)"]);
    assert.match(result.stdout, /  Error: secret=changeme token: abc see https:\/\/example\.com:8080\/a@b/);
    assert.doesNotMatch(result.stdout, /redacted/);
  });
});

// What the command writes, captured directly (stdout then stderr in program order is the same bytes as the log for this one-process command).
const run_raw = (source) => {
  const ran = spawnSync(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  return Buffer.from(ran.stdout.toString("utf8") + ran.stderr.toString("utf8"));
};
