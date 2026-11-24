// Tests for the debabble command end to end: output lines, exit codes, the log, env switches, usage errors, and a kill mid-run.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: bin/debabble.mjs (through test/helpers.mjs).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { BIN, cleanEnv, cli, logPathOf, tmp } from "./helpers.mjs";

const node = (source) => [process.execPath, "-e", source];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("green runs", () => {
  it("prints the log path first and one closing line with time and log; every byte of output is in the log", () => {
    const result = cli(["--label", "pnpm test", "--", ...node("console.log('noise a'); console.error('noise b')"), ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.lines.length, 2, result.stdout);
    const path = logPathOf(result.stdout);
    assert.match(result.lines[0], /^log: /);
    assert.match(result.lines[1], new RegExp(`^✓ pnpm test · \\d+\\.\\ds · log: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    assert.doesNotMatch(result.stdout, /noise/);
    assert.equal(readFileSync(path, "utf8"), "noise a\nnoise b\n");
  });

  it("the log folder is 0700, the log 0600, and the name is <timestamp>-<label>.log", () => {
    const result = cli(["--label", "pnpm build", "--", ...node("1")]);
    const path = logPathOf(result.stdout);
    assert.match(path, /\/\d{8}-\d{6}-pnpm-build\.log$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  });

  it("a warning after a long success preamble is named on the green line, first one only, with the count", () => {
    const preamble = "for (let i = 0; i < 5000; i++) console.log('fine ' + i);";
    const one = cli(["--", ...node(`${preamble} console.log('warning: legacy flag is deprecated')`)]);
    assert.match(one.lines.at(-1), /^✓ .* · 1 warning: "warning: legacy flag is deprecated" · log: /);
    const two = cli(["--", ...node("console.log('warn: a'); console.log('warn: b')")]);
    assert.match(two.lines.at(-1), / · 2 warnings, first: "warn: a" · log: /);
  });

  it("a green run that prints an error-shaped line says so on its line", () => {
    const result = cli(["--", ...node("console.log('Error: tolerated'); console.log('ok')")]);
    assert.equal(result.status, 0);
    assert.match(result.lines.at(-1), /^✓ .* · 1 error-like line: "Error: tolerated" · log: /);
  });

  it("works under a path with spaces, and the log path it prints exists", () => {
    const cwd = tmp("my project");
    assert.match(cwd, / /);
    const result = cli(["--", ...node("console.log(process.cwd())")], { cwd });
    assert.equal(existsSync(logPathOf(result.stdout)), true);
    assert.match(readFileSync(logPathOf(result.stdout), "utf8"), /my project/);
  });
});

describe("red runs", () => {
  it("keeps the exit code: exit 3 is exit 3, and the header says so", () => {
    const result = cli(["--", ...node("console.log('before'); process.exit(3)")]);
    assert.equal(result.status, 3);
    assert.match(result.lines[1], /^✗ .* · exit 3 · \d+\.\ds$/);
    assert.equal(result.lines[2], "  before");
    assert.match(result.lines.at(-1), /^log: /);
    assert.equal(result.lines.length, 4);
  });

  it("a planted failure after 500 dot lines still shows, with the log path, and none of the dot lines", () => {
    const dots = ".".repeat(20);
    const result = cli(["--", ...node(`for (let i = 0; i < 500; i++) console.log('${dots}'); console.log('✖ the planted failure'); console.error('AssertionError: 1 == 2'); process.exit(1)`)]);
    assert.equal(result.status, 1);
    assert.ok(result.lines.includes("  ✖ the planted failure"), result.stdout);
    assert.ok(result.lines.includes("  AssertionError: 1 == 2"));
    assert.equal(result.lines.filter((line) => /^\s*[.·]+\s*$/.test(line)).length, 0);
    assert.ok(result.lines.length < 12, `short (${result.lines.length} lines)`);
    assert.equal(readFileSync(logPathOf(result.stdout), "utf8").split("\n").filter((line) => line === dots).length, 500);
  });

  it("shows a failure that only reached stderr", () => {
    const result = cli(["--", ...node("console.error('boom on stderr'); process.exit(2)")]);
    assert.equal(result.status, 2);
    assert.ok(result.lines.includes("  boom on stderr"));
  });

  it("a warning in a long failed log shows beside the real error, and the preamble does not", () => {
    const preamble = "for (let i = 0; i < 5000; i++) console.log('fine ' + i);";
    const result = cli(["--", ...node(`${preamble} console.log('warning: legacy flag is deprecated'); console.error('Error: the real one'); process.exit(1)`)]);
    assert.ok(result.lines.includes("  Error: the real one"));
    assert.ok(result.lines.includes("  warning: legacy flag is deprecated"));
    assert.ok(!result.lines.includes("  fine 100"));
    assert.ok(result.lines.some((line) => /^ {2}… \d+ lines not shown …$/.test(line)));
    assert.ok(result.lines.length < 60);
  });

  it("with output that names no error, shows the end of it and says so; with no output, says that", () => {
    const odd = cli(["--", ...node("for (let i = 0; i < 300; i++) console.log('row ' + i); process.exit(1)")]);
    assert.ok(odd.lines.includes("  (no line names an error; the end of the output:)"));
    assert.ok(odd.lines.includes("  row 299") && !odd.lines.includes("  row 5"));
    assert.ok(cli(["--", ...node("process.exit(1)")]).lines.includes("  (the command printed nothing)"));
  });

  it("prints a failing short log whole and in order under 2>&1", () => {
    const source = "const { writeSync } = require('node:fs'); for (let i = 0; i < 40; i++) writeSync(i % 2 ? 2 : 1, (i % 2 ? 'err ' : 'out ') + i + '\\n'); process.exit(1)";
    const merged = spawnSync("sh", ["-c", `"${process.execPath}" "${BIN}" -- "${process.execPath}" -e "$SRC" 2>&1`], { cwd: tmp(), encoding: "utf8", env: cleanEnv({ SRC: source }) });
    assert.equal(merged.status, 1);
    const lines = merged.stdout.split("\n").filter(Boolean);
    assert.deepEqual(lines.slice(2, -1).map((line) => line.slice(2)), Array.from({ length: 40 }, (_, i) => `${i % 2 ? "err" : "out"} ${i}`));
  });

  it("a 5 MB log with a 3 MB line gets a small excerpt with both ends, and the log keeps all of it", () => {
    const source = "const { writeSync } = require('node:fs'); writeSync(1, 'Error: first, at the top\\n'); for (let i = 0; i < 50000; i++) writeSync(i % 2 ? 2 : 1, 'filler line ' + i + ' ' + 'x'.repeat(90) + '\\n'); writeSync(1, 'y'.repeat(3000000)); writeSync(2, '\\nError: last, at the bottom\\n'); process.exit(1)";
    const result = cli(["--", ...node(source)]);
    assert.equal(result.status, 1);
    assert.ok(statSync(logPathOf(result.stdout)).size > 7_500_000);
    assert.ok(result.stdout.length < 30_000, `small (${result.stdout.length} bytes)`);
    assert.ok(result.lines.includes("  Error: first, at the top") && result.lines.includes("  Error: last, at the bottom"));
    assert.match(result.stdout, /\[…\d+ more characters\]/);
  });

  it("the excerpt is at most 130 lines for any log", () => {
    const result = cli(["--", ...node("for (let i = 0; i < 6000; i++) console.log(i % 3 ? 'row ' + i : 'Error: boom ' + i); process.exit(1)")]);
    assert.ok(result.lines.length <= 130 + 3, `${result.lines.length} lines`);
  });

  it("a command that does not exist is 127 and says it did not start; one that cannot run is 126", () => {
    const missing = cli(["--", "debabble-no-such-command"]);
    assert.equal(missing.status, 127);
    assert.match(missing.lines.at(-1), /^✗ debabble-no-such-command · did not start: .* · log: /);
    const dir = tmp();
    const notRunnable = cli(["--", join(dir, "plain.txt")], { cwd: dir });
    assert.ok([126, 127].includes(notRunnable.status));
  });
});

describe("timeout and signals", () => {
  it("stops a command that outlives --timeout, exits 124, and says it timed out", () => {
    const result = cli(["--timeout", "1500ms", "--", ...node("console.log('started'); setTimeout(() => {}, 60000)")]);
    assert.equal(result.status, 124);
    assert.match(result.lines.at(-1), /^✗ .* · timed out after 2s \(stopped the process tree\) · log: /);
    assert.equal(readFileSync(logPathOf(result.stdout), "utf8"), "started\n");
  });

  it("DEBABBLE_TIMEOUT_MS sets the default; --timeout wins over it", () => {
    const env = cleanEnv({ DEBABBLE_TIMEOUT_MS: "1500" });
    assert.equal(cli(["--", ...node("setTimeout(() => {}, 60000)")], { env }).status, 124);
    assert.equal(cli(["--timeout", "30s", "--", ...node("console.log('fast')")], { env }).status, 0);
  });

  it("a command ended by a signal is reported as that signal and exits 128+n", () => {
    const result = cli(["--", ...node("console.log('x'); process.kill(process.pid, 'SIGKILL')")]);
    assert.equal(result.status, 137);
    assert.match(result.lines.at(-1), /^✗ .* · killed by SIGKILL · \d+\.\ds · log: /);
  });

  it("killing debabble mid-run prints the log path first, then the path again on the way out, exits 128+n, and takes the command's tree with it", async () => {
    const root = tmp();
    const marker = join(root, "child.pid");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); console.log('working'); setTimeout(() => {}, 60000)`;
    const child = spawn(process.execPath, [BIN, "--", ...node(source)], { cwd: root, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (piece) => {
      out += piece;
    });
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    // Wait for the command to be running (its marker exists), so the kill lands mid-run.
    for (let waited = 0; !existsSync(marker) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(marker), true, "the command started");
    assert.match(out, /^log: .+\n/, "the log path was printed before the kill");
    child.kill("SIGTERM");
    const { code } = await closed;
    assert.equal(code, 143);
    const lines = out.split("\n").filter(Boolean);
    assert.match(lines[0], /^log: /);
    assert.match(lines.at(-1), /^✗ .* · killed by SIGTERM · \d+\.\ds · log: /);
    assert.equal(lines[0].slice(5), lines.at(-1).split(" · log: ")[1]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(Number(readFileSync(marker, "utf8"))), false, "the command was stopped");
    assert.match(readFileSync(lines[0].slice(5), "utf8"), /working/);
  });
});

describe("env switches", () => {
  it("DEBABBLE=off passes output straight through, writes no log, and keeps the exit code", () => {
    const env = cleanEnv({ DEBABBLE: "off" });
    const result = cli(["--", ...node("console.log('plain out'); console.error('plain err'); process.exit(4)")], { env });
    assert.equal(result.status, 4);
    assert.equal(result.stdout, "plain out\n");
    assert.equal(result.stderr, "plain err\n");
    assert.equal(existsSync(env.DEBABBLE_LOG_DIR) ? readdirSync(env.DEBABBLE_LOG_DIR).length : 0, 0);
  });

  it("in CI (CI=true, or GITHUB_ACTIONS=true) it is a passthrough, but CI=false and CI= are not CI", () => {
    for (const extra of [{ CI: "true" }, { CI: "1" }, { GITHUB_ACTIONS: "true" }]) {
      const result = cli(["--", ...node("console.log('noise')")], { env: cleanEnv(extra) });
      assert.equal(result.stdout, "noise\n", JSON.stringify(extra));
    }
    for (const extra of [{ CI: "false" }, { CI: "" }]) assert.match(cli(["--", ...node("console.log('noise')")], { env: cleanEnv(extra) }).stdout, /^log: /, JSON.stringify(extra));
  });

  it("a passthrough keeps signal and timeout exits", () => {
    const env = cleanEnv({ DEBABBLE: "off" });
    assert.equal(cli(["--", ...node("process.kill(process.pid, 'SIGKILL')")], { env }).status, 137);
    assert.equal(cli(["--timeout", "1s", "--", ...node("setTimeout(() => {}, 60000)")], { env }).status, 124);
    assert.equal(cli(["--", "debabble-no-such-command"], { env }).status, 127);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    it(`killing a passthrough with ${signal} stops the command's whole tree (a grandchild too) and exits 128+n`, async () => {
      const root = tmp();
      const marker = join(root, "grandchild.pid");
      // The command starts a grandchild (sleep) and waits on it, so only a tree stop reaches the sleep.
      const source = `const s = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(s.pid)); setTimeout(() => {}, 60000)`;
      const child = spawn(process.execPath, [BIN, "--", ...node(source)], { cwd: root, env: cleanEnv({ DEBABBLE: "off" }), stdio: "ignore" });
      const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
      for (let waited = 0; !existsSync(marker) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const grandchild = Number(readFileSync(marker, "utf8"));
      assert.equal(alive(grandchild), true, "the grandchild started");
      child.kill(signal);
      assert.equal(await closed, signal === "SIGTERM" ? 143 : 130);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(alive(grandchild), false, "the grandchild was stopped");
    });
  }

  // A passthrough command that traps SIGTERM: it writes `ready` once the trap is set, and on SIGTERM writes `cleaned` and exits 0 after 200 ms
  // (or, with `ignore`, keeps running).
  const trapper = (root, ignore = false) => {
    const [ready, cleaned] = [join(root, "ready"), join(root, "cleaned")];
    const onTerm = ignore ? "() => {}" : `() => setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(cleaned)}, 'yes'); process.exit(0); }, 200)`;
    return { ready, cleaned, source: `process.on('SIGTERM', ${onTerm}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => {}, 60000)` };
  };
  const killWhenReady = async (child, ready, signal) => {
    const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    for (let waited = 0; !existsSync(ready) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(ready), true, "the command set its trap");
    const sent = Date.now();
    child.kill(signal);
    return { code: await closed, ms: Date.now() - sent };
  };

  it("killing a passthrough first sends the command the same signal, so a command that traps it shuts down cleanly within the grace period", async () => {
    const root = tmp();
    const { ready, cleaned, source } = trapper(root);
    const child = spawn(process.execPath, [BIN, "--", ...node(source)], { cwd: root, env: cleanEnv({ DEBABBLE: "off" }), stdio: "ignore" });
    const { code } = await killWhenReady(child, ready, "SIGTERM");
    assert.equal(code, 143);
    assert.equal(existsSync(cleaned), true, "the command ran its SIGTERM cleanup");
  });

  it("a passthrough command that ignores the signal has its tree stopped after DEBABBLE_KILL_GRACE_MS", async () => {
    const root = tmp();
    const { ready, source } = trapper(root, true);
    const child = spawn(process.execPath, [BIN, "--", ...node(source)], { cwd: root, env: cleanEnv({ DEBABBLE: "off", DEBABBLE_KILL_GRACE_MS: "300" }), stdio: "ignore" });
    const { code, ms } = await killWhenReady(child, ready, "SIGTERM");
    assert.equal(code, 143);
    assert.ok(ms >= 250 && ms < 3000, `${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(Number(readFileSync(ready, "utf8"))), false, "the command was stopped");
  });

  it("no log folder at all (the temp folder fails too): one stderr line, and the command still runs, as the passthrough", () => {
    const result = cli(["--log-dir", "/dev/null/x", "--", ...node("console.log('ran'); process.exit(3)")], { env: cleanEnv({ TMPDIR: "/dev/null/y" }) });
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "ran\n");
    assert.match(result.stderr, /^debabble: can't use log folder \/dev\/null\/x\/\S+ or a temp folder \(ENOTDIR\); running without a log\n$/);
  });

  it("a log folder it can't use: one stderr line naming it and why, and the run still logs", () => {
    const blocker = join(tmp("base"), "a-file");
    writeFileSync(blocker, "");
    const spare = tmp("tmp");
    const result = cli(["--log-dir", blocker, "--", ...node("console.log('ran')")], { env: cleanEnv({ TMPDIR: spare }) });
    assert.equal(result.status, 0);
    const lines = result.stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^debabble: can't use log folder ${blocker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\S+ \\(ENOTDIR\\); logging to `));
    assert.ok(logPathOf(result.stdout).startsWith(join(spare, "debabble-")));
    assert.equal(readFileSync(logPathOf(result.stdout), "utf8"), "ran\n");
  });

  it("--log-dir and DEBABBLE_LOG_DIR choose the base folder; --log-dir wins", () => {
    const [flagDir, envDir] = [tmp("flag"), tmp("env")];
    const fromFlag = cli(["--log-dir", flagDir, "--", ...node("1")], { env: cleanEnv({ DEBABBLE_LOG_DIR: envDir }) });
    assert.ok(logPathOf(fromFlag.stdout).startsWith(flagDir));
    const fromEnv = cli(["--", ...node("1")], { env: cleanEnv({ DEBABBLE_LOG_DIR: envDir }) });
    assert.ok(logPathOf(fromEnv.stdout).startsWith(envDir));
  });

  it("with no override it logs under XDG_STATE_HOME/debabble", () => {
    const xdg = tmp("xdg");
    const env = { ...cleanEnv(), XDG_STATE_HOME: xdg };
    delete env.DEBABBLE_LOG_DIR;
    assert.ok(logPathOf(cli(["--", ...node("1")], { env }).stdout).startsWith(join(xdg, "debabble")));
  });
});

describe("--show excerpt", () => {
  it("green: counts failure lines of all lines and shows them; red: as the default mode", () => {
    const green = cli(["--show", "excerpt", "--label", "gh run view 1 --log", "--", ...node("for (let i = 0; i < 100; i++) console.log('row ' + i); console.log('build  ✗ a.test > b'); for (let i = 0; i < 100; i++) console.log('row ' + i)")]);
    assert.equal(green.status, 0);
    assert.match(green.lines[1], /^✓ gh run view 1 --log · \d+\.\ds · 1 failure line of 201$/);
    assert.ok(green.lines.includes("  build  ✗ a.test > b"));
    assert.match(green.lines.at(-1), /^log: /);
    const quiet = cli(["--show", "excerpt", "--", ...node("console.log('all fine')")]);
    assert.match(quiet.lines.at(-1), /^✓ .* · 0 failure lines of 1 · log: /);
    assert.equal(cli(["--show", "excerpt", "--", ...node("console.log('Error: x'); process.exit(1)")]).lines[1].startsWith("✗"), true);
  });
});

describe("usage errors", () => {
  const usage = (args) => {
    const result = cli(args);
    assert.equal(result.status, 125, JSON.stringify(args));
    assert.equal(result.stdout, "", "nothing on stdout");
    assert.match(result.stderr, /^debabble: .+\n$/);
    assert.equal(result.stderr.trim().split("\n").length, 1, "one line");
    return result.stderr;
  };

  it("no `--`, nothing at all, nothing after `--`, an unknown flag, a flag with no value, and bad values are exit 125 with one line on stderr", () => {
    assert.match(usage(["node", "-v"]), /no `--`/);
    assert.match(usage([]), /usage: debabble/);
    assert.match(usage(["--"]), /no command/);
    assert.match(usage(["--bogus", "--", "node"]), /unknown flag --bogus/);
    assert.match(usage(["--show"]), /--show needs a value|no `--`/);
    assert.match(usage(["--show", "loud", "--", "node"]), /--show takes verdict or excerpt/);
    assert.match(usage(["--timeout", "soon", "--", "node"]), /--timeout takes a duration/);
    assert.match(usage(["--timeout", "0", "--", "node"]), /--timeout takes a duration/);
    assert.match(usage(["--label", "--", "node"]), /--label|no `--`|unknown/);
  });

  it("a command's own flags after `--` belong to the command, not to debabble", () => {
    const result = cli(["--", "sh", "-c", 'echo "$@"', "sh", "--show", "loud", "--timeout", "x"]);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(logPathOf(result.stdout), "utf8"), "--show loud --timeout x\n");
  });
});
