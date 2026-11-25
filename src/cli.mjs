// The debabble command: runs a command with all its output in a log file and prints one line when it passes, an excerpt when it fails.
// In the app: bin/debabble.mjs calls `main`; the library (src/index.mjs) exposes the same pieces without the printing.
// Run: `debabble [--show verdict|excerpt] [--timeout <dur>] [--label <name>] [--log-dir <path>] -- <cmd> [args…]`
// When: in front of a command whose output is long and mostly noise (test runs, builds, log readers); not for interactive programs (stdin is closed).
// Env: DEBABBLE=off (run the command with its output passed straight through); DEBABBLE_LOG_DIR (log base folder); DEBABBLE_TIMEOUT_MS (default timeout in ms); XDG_STATE_HOME (log base when no other is set); CI, GITHUB_ACTIONS (passthrough, as `off`);
//   DEBABBLE_KILL_GRACE_MS (how long a killed passthrough's command has to exit before its tree is stopped; default 5000).
// Prints: the label, verdict line and excerpt with secret-shaped text masked as `<redacted:shape>` (src/redact.mjs); the log keeps the command's bytes as written.
// Writes: one log file per run under the log folder (0600 in a 0700 folder, pruned to 200 files and 7 days); stdout lines only; stderr only for a
//   usage error, a command that did not start in the passthrough, or a log folder it can't use (one line naming it and the fallback folder;
//   when no temp folder works either, the line says so and the command runs as the passthrough, with no log).
// Exit: the command's code; 128+n when signal n ended it (also when debabble itself is killed); 124 timed out (as timeout(1)); 125 usage error; 127 not found; 126 not runnable.
// Used by: bin/debabble.mjs; tested by test/cli.test.mjs.
// Uses: src/scan.mjs, src/run.mjs, src/logs.mjs, src/redact.mjs.
// Exports: parseArgs(argv, env), main(argv, { env, cwd }) → exit code.
//
// Output (stdout): first `log: <path>` (so a reader that only sees the start of a backgrounded run still has the path), then, for a green run, one line
//   `✓ <label> · 41.2s · log: <path>` (with `· 1 warning: "…"` and `· 1 error-like line: "…"` before the path when the log holds any), or for a red run
//   `✗ <label> · exit 1 · 38.9s`, the excerpt indented two spaces, and a last line `log: <path>`. A timeout or kill is one line ending ` · log: <path>`.
//   `--show excerpt` is for log readers (`gh run view --log`): green prints `✓ … · N failure lines of M` and those lines, red as above.
// `--` is required so a tool that reads the line can find the command without knowing debabble's flags.

import { writeSync } from "node:fs";
import { constants } from "node:os";
import { EXCERPT_MAX_LINES, excerptLines, scanLog } from "./scan.mjs";
import { DEFAULT_TIMEOUT_MS, MAX_TIMER_MS, run, signalTree, stopTree } from "./run.mjs";
import { logDirFor, openLog } from "./logs.mjs";
import { lineRedactor, redactText } from "./redact.mjs";

// How long a killed passthrough's command has to exit on the signal it was sent before its tree is stopped; DEBABBLE_KILL_GRACE_MS overrides.
const KILL_GRACE_MS = 5000;
const killGraceMs = (env) => {
  const ms = Number(env.DEBABBLE_KILL_GRACE_MS);
  return (env.DEBABBLE_KILL_GRACE_MS ?? "") !== "" && Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_TIMER_MS) : KILL_GRACE_MS;
};

const USAGE = "usage: debabble [--show verdict|excerpt] [--timeout <dur>] [--label <name>] [--log-dir <path>] -- <cmd> [args…]";
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

// A duration as written (`90s`, `30m`, `1500ms`, `2h`; a bare number is seconds) in ms, or null when it is not one.
const parseDuration = (text) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) return null;
  const ms = Number(match[1]) * UNITS[match[2] ?? "s"];
  return ms > 0 ? Math.min(Math.round(ms), MAX_TIMER_MS) : null;
};

// Parses argv: { flags, command, args } or { error }. Nothing before the `--` may be anything but a flag with its value.
export const parseArgs = (argv, env = process.env) => {
  const flags = { show: "verdict", label: undefined, logDir: undefined, timeoutMs: undefined };
  const dash = argv.indexOf("--");
  if (dash === -1) return { error: argv.length === 0 ? USAGE : `no \`--\` before the command; ${USAGE}` };
  const before = argv.slice(0, dash);
  for (let i = 0; i < before.length; i += 1) {
    const name = before[i];
    const value = before[i + 1];
    if (!["--show", "--timeout", "--label", "--log-dir"].includes(name)) return { error: `unknown flag ${name}; ${USAGE}` };
    if (value === undefined) return { error: `${name} needs a value; ${USAGE}` };
    i += 1;
    if (name === "--show") {
      if (value !== "verdict" && value !== "excerpt") return { error: `--show takes verdict or excerpt, not ${value}` };
      flags.show = value;
    } else if (name === "--timeout") {
      flags.timeoutMs = parseDuration(value);
      if (flags.timeoutMs === null) return { error: `--timeout takes a duration like 90s, 30m or 1500ms, not ${value}` };
    } else if (name === "--label") flags.label = value;
    else flags.logDir = value;
  }
  const [command, ...args] = argv.slice(dash + 1);
  if (command === undefined || command === "") return { error: `no command after \`--\`; ${USAGE}` };
  if (flags.timeoutMs === undefined) {
    const fromEnv = Number(env.DEBABBLE_TIMEOUT_MS);
    flags.timeoutMs = Number.isFinite(fromEnv) && fromEnv > 0 ? Math.min(fromEnv, MAX_TIMER_MS) : DEFAULT_TIMEOUT_MS;
  }
  return { flags, command, args };
};

// Whether this is a CI run: CI set and not "false", or GitHub Actions. Its log is the only record there, so debabble steps aside.
const inCi = (env) => ((env.CI ?? "") !== "" && env.CI.toLowerCase() !== "false") || env.GITHUB_ACTIONS === "true";

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Elapsed time as the lines show it: `3.1s`, `41.2s`, `1m47s`.
const elapsed = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);
// A limit as `timeout(1)` people write it: `30m0s`, `90s`, `1h2m3s`, `500ms`.
const span = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h > 0 ? `${h}h${m}m${r}s` : m > 0 ? `${m}m${r}s` : `${r}s`;
};
const signalNumber = (name) => constants.signals[name] ?? 0;
// The exit code for a command that did not start: 126 when it exists but cannot run, 127 when it is not found (as a shell).
const notStartedCode = (error) => (error.code === "EACCES" ? 126 : 127);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Writes text to fd 1 or 2 synchronously, so nothing is pending at `process.exit` and lines to both keep their order under `2>&1`.
// A full non-blocking pipe (EAGAIN) is waited out; any other failure (a closed pipe) drops the text rather than crash.
const emit = (fd, text) => {
  const buffer = Buffer.from(text.endsWith("\n") ? text : `${text}\n`);
  let done = 0;
  let spins = 0;
  while (done < buffer.length) {
    try {
      done += writeSync(fd, buffer, done);
      spins = 0;
    } catch (error) {
      if (error.code !== "EAGAIN" || ++spins > 50_000) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
};

// The full CLI, as a function: returns the exit code instead of exiting.
export const main = async (argv, { env = process.env, cwd = process.cwd() } = {}) => {
  const parsed = parseArgs(argv, env);
  if (parsed.error) {
    emit(2, `debabble: ${parsed.error}`);
    return 125;
  }
  const { flags, command, args } = parsed;
  // CI and DEBABBLE=off: the passthrough, with no log (logFile stays undefined) and no lines of ours; timeout, kill and exit codes as below.
  let passthrough = env.DEBABBLE === "off" || inCi(env);

  // The label is printed and names the log file, so it is masked too (a command line can carry `https://user:pass@host`).
  const label = clip(redactText(flags.label ?? [command, ...args].join(" ")), 120);
  let logFile;
  if (!passthrough) {
    const dir = logDirFor(cwd, env, flags.logDir);
    try {
      const opened = openLog(dir, label);
      logFile = opened.logFile;
      if (opened.fallback) emit(2, `debabble: can't use log folder ${opened.fallback.dir} (${opened.fallback.error}); logging to ${opened.dir}`);
      emit(1, `log: ${logFile}`);
    } catch (error) {
      // No folder at all can take a log (the temp folder fails too): the command still runs, as the passthrough.
      emit(2, `debabble: can't use log folder ${dir} or a temp folder (${error.code ?? error.message}); running without a log`);
      passthrough = true;
    }
  }
  const running = run({ command, args, cwd, logFile, env, timeoutMs: flags.timeoutMs });
  const started = Date.now();

  // A kill of debabble itself (a task runner's timeout, Ctrl-C): stop the command's tree, say where the log is (if any), and exit 128+n.
  const stop = (signal) => {
    stopTree(running.child.pid);
    if (!passthrough) emit(1, `✗ ${label} · killed by ${signal} · ${elapsed(Date.now() - started)} · log: ${logFile}`);
    process.exit(128 + signalNumber(signal));
  };
  // The passthrough (CI, DEBABBLE=off) stands in for the command, so the command gets the chance to shut down as it would unwrapped (Ctrl-C
  // cleanup, a CI cancel): the same signal goes to its whole tree first, and the tree stop follows after the grace period, or at once on a
  // second signal. Exit 128+n either way.
  let killedBy = null;
  let escalate;
  const onKill = (signal) => {
    if (!passthrough || killedBy !== null) return stop(killedBy ?? signal);
    killedBy = signal;
    signalTree(running.child.pid, signal);
    escalate = setTimeout(() => stop(signal), killGraceMs(env));
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onKill);

  const ran = await running;
  clearTimeout(escalate);
  for (const signal of signals) process.off(signal, onKill);
  if (killedBy !== null) return 128 + signalNumber(killedBy);
  if (passthrough) {
    if (ran.timedOut) return 124;
    if (ran.error) {
      emit(2, `debabble: ${redactText(`${command}: ${ran.error.message}`)}`);
      return notStartedCode(ran.error);
    }
    return ran.signal ? 128 + signalNumber(ran.signal) : (ran.status ?? 1);
  }
  const time = elapsed(ran.ms);

  if (ran.timedOut) {
    emit(1, `✗ ${label} · timed out after ${span(flags.timeoutMs)} (stopped the process tree) · log: ${logFile}`);
    return 124;
  }
  if (ran.error) {
    emit(1, `✗ ${label} · did not start: ${redactText(ran.error.message)} · log: ${logFile}`);
    return notStartedCode(ran.error);
  }
  if (ran.signal) {
    emit(1, `✗ ${label} · killed by ${ran.signal} · ${time} · log: ${logFile}`);
    return 128 + signalNumber(ran.signal);
  }
  if (ran.status === null) {
    emit(1, `✗ ${label} · ended without an exit code · ${time} · log: ${logFile}`);
    return 1;
  }

  // Everything shown from the log passes through the line redactor; the log file itself is never touched.
  const scan = scanLog(logFile, { redact: lineRedactor() });
  if (ran.status === 0) {
    if (flags.show === "excerpt") {
      const found = `${plural(scan.failures, "failure line")} of ${scan.total.toLocaleString("en-US")}`;
      if (scan.failures === 0) emit(1, `✓ ${label} · ${time} · ${found} · log: ${logFile}`);
      else emit(1, [`✓ ${label} · ${time} · ${found}`, ...excerptLines(scan).map((text) => `  ${text}`), `log: ${logFile}`].join("\n"));
      return 0;
    }
    // A green run can still print what looks like a failure (a tolerated error) or a warning: say so on its line, first one only.
    const errors = scan.failures > 0 ? ` · ${scan.failures === 1 ? "1 error-like line:" : `${scan.failures} error-like lines, first:`} "${clip(scan.firstFailure, 100)}"` : "";
    const warnings = scan.warnings > 0 ? ` · ${scan.warnings === 1 ? "1 warning:" : `${scan.warnings} warnings, first:`} "${clip(scan.firstWarning, 100)}"` : "";
    emit(1, `✓ ${label} · ${time}${errors}${warnings} · log: ${logFile}`);
    return 0;
  }
  const shown = excerptLines(scan).slice(0, EXCERPT_MAX_LINES);
  emit(1, [`✗ ${label} · exit ${ran.status} · ${time}`, ...shown.map((text) => `  ${text}`), `log: ${logFile}`].join("\n"));
  return ran.status;
};
