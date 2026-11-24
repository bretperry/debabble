// Reads a command's log in one pass and cuts the lines worth showing: failure blocks, the tail, counts of errors, warnings and progress.
// In the app: a library module; run.mjs's caller (cli.mjs) prints what this returns. Pure over a file path, fixed memory.
// Used by: src/cli.mjs, src/index.mjs; tested by test/scan.test.mjs.
// Uses: node builtins only.
// Exports: TAIL_LINES, EXCERPT_MAX_LINES, isProgressLine(line), scanLog(logFile, knobs?), excerptLines(scan).
//
// What a red run prints is cut from the file after the run is over: the lines that name a failure (each with a line before and a few after;
// the cap is split so the first failures and the last ones both show), then the last lines, in file order, with a marker where lines were left
// out. A short log prints whole. Progress lines (a test runner's dots, per-file pass lines, `ok pkg`) are never shown: PROGRESS_LINE lists
// every shape, and a line that names a failure is never one of them. The log is the record; the exit code is the verdict.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// The most lines an excerpt may have, markers included: 100 block + 30 tail, with a hard cut if the markers push it past.
export const EXCERPT_MAX_LINES = 130;
// A log of at most this many lines is printed whole when its command fails.
const FULL_LOG_LINES = 60;
// Around a failure-shaped line: lines kept before and after it, and the most lines all such blocks may keep.
const LINES_BEFORE = 1;
const LINES_AFTER = 5;
const MAX_BLOCK_LINES = 100;
// The last lines of a long failed log are always shown, whatever they say.
export const TAIL_LINES = 30;
// A line longer than this is cut when shown (a minified bundle, a progress bar); the log keeps it whole.
const LINE_CHARS = 1000;

// A line that names a failure. "0 errors" and "no failures" are blanked first, so "2 failed, 0 errors" still counts.
// A word that is part of a hyphenated name, path, or identifier ("quick-error", "wait-timeout", "src/error.ts") is not a failure.
const FAILURE_LINE = /(?<![-/])\b(error|errors|fail|failed|failure|failing|fatal|panic|exception|traceback|assertion|not ok|cannot|can't|unable|denied|refused|timed? ?out)\b(?!-|\.\w)|✗|✖|×/i;
// An exception or error class by name (`TypeError`, `ReferenceError`, `RuntimeError`, `ModuleNotFoundError`, `AssertionError`,
// `java.lang.NullPointerException`): the `\b` in FAILURE_LINE sees no word break inside a CamelCase name. Case-sensitive on purpose, so
// "noerror" or "errors" never match here; a name inside a hyphenated or slashed path ("src/TypeError.ts", "quick-Error") is not a failure.
const ERROR_NAME = /(?<![\w/-])[A-Z][A-Za-z0-9_]*(?:Error|Exception)(?![\w-]|\.\w)/;
// The start of a failure report, as opposed to an error-shaped line anywhere: kept in a window of its own, so a flood of generic lines
// after it (a stack trace, a retry log) cannot push it out.
const FAILURE_START = /^\s*(FAIL(ED)?\b|--- FAIL|not ok\b|✗|✖|×|Traceback|thread '.*' panicked|panic:|\w*Assertion\w*)/;
// A test runner's progress line: it says "still going", never what went wrong, so a failure report is better without it. One shape per
// common runner (measured 2026-10-29):
//   dots         node:test `--test-reporter=dot` and other dot reporters (`.` and `·`), unittest and `pytest -q` without a %:
//                a line of nothing but those marks, starting in column 0 (an indented `...` is diff context or a report's own text, so it stays).
//                A line with an `X`, `F` or `E` in it is NOT progress: it marks the failure.
//   pytest       `tests/test_a.py ....s.  [ 40%]` and, with -q, `....  [ 40%]`: marks of pass/skip/xfail only, then the percent.
//   file totals  a passing file, `✓ tests/a (12 tests) 34ms`. (Failures print `❯` and `×`.)
//   node:test    the spec reporter's passing test, `✔ name (1.2ms)`.
//   go test      `ok  \tpkg\t0.3s`, `?   \tpkg\t[no test files]`; with -v also `=== RUN`, `=== PAUSE`, `=== CONT`, `--- PASS:`, `--- SKIP:`.
//   nextest      `PASS [ 0.01s] crate test`, `START`, `SLOW`, `SKIP` (shown only when the status level is raised), and cargo's `Compiling x v1`.
//   unittest -v  `test_a (mod.Class) ... ok`.
const PROGRESS_LINE = new RegExp(
  [
    String.raw`^[.·]+\s*$`,
    String.raw`^\s*(?:\S+\.py\s+)?[.sx]+\s+\[\s*\d+%\]\s*$`,
    String.raw`^\s*✓ \S.* \(\d+ tests?(?: [|] \d+ skipped)?\)(?: \d+ms)?\s*$`,
    String.raw`^\s*✔ .* \([\d.]+m?s\)\s*$`,
    String.raw`^ok\s+\S+\s+(?:[\d.]+s|\(cached\))`,
    String.raw`^\?\s+\S+\s+\[no test files\]\s*$`,
    String.raw`^\s*=== (?:RUN|PAUSE|CONT|NAME)\b`,
    String.raw`^\s*--- (?:PASS|SKIP): `,
    String.raw`^\s*(?:PASS|START|SLOW|SKIP) +\[ *[\d.]+s\]`,
    String.raw`^\s*Compiling \S+ v\d`,
    String.raw`^\S.* \.\.\. ok\s*$`,
  ].join("|"),
);
const NOT_A_FAILURE = /\b(0|no|zero) (errors?|failures?|failed|failing)\b|\b(errors?|failures?|failed)[:=] ?0\b/gi;
const WARNING_LINE = /\bwarn(ing|ings)?\b|‼|⚠/i;
const NOT_A_WARNING = /\b(0|no|zero) warnings?\b|\bwarnings?[:=] ?0\b/gi;
// Colors and cursor moves (CSI), and operating-system commands (OSC: window titles, hyperlinks), which end in BEL or ESC \.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)`, "g");

const isFailureLine = (line) => {
  const text = line.replaceAll(NOT_A_FAILURE, " ");
  return FAILURE_LINE.test(text) || ERROR_NAME.test(text);
};
// Whether a line is progress (PROGRESS_LINE) and names no failure: the failure test goes first, so no pattern can hide an error.
export const isProgressLine = (line) => {
  const plain = line.replace(ANSI, "");
  return PROGRESS_LINE.test(plain) && !isFailureLine(plain);
};
const isWarningLine = (line) => WARNING_LINE.test(line.replaceAll(NOT_A_WARNING, " "));

// One pass over the log in fixed memory. Returns what a report needs:
//   total lines (progress lines included, so line numbers match the file), how many of them were progress, the first FULL_LOG_LINES (for a
//   short log), the lines kept around failure-shaped ones, the last TAIL_LINES (none of these hold a progress line),
//   how many failure-shaped lines there were with the first of them, and how many warning lines with the first of them.
// `redact` (default: none) masks each line as it is kept, so a line cut at lineChars never shows half a secret.
// The kept lines have two halves of maxBlock/2: the first failures' lines, and a rolling window of the latest, so a real failure after a
// flood of early noise still shows.
export const scanLog = (logFile, { redact = (text) => text, lineChars = LINE_CHARS, fullLines = FULL_LOG_LINES, before = LINES_BEFORE, after = LINES_AFTER, maxBlock = MAX_BLOCK_LINES, tail = TAIL_LINES } = {}) => {
  const out = { total: 0, bytes: 0, progress: 0, head: [], blocks: new Map(), tail: [], failures: 0, firstFailure: "", warnings: 0, firstWarning: "" };
  // The kept lines: the first half of the cap to whatever fails first, then two rolling windows of a quarter each, one for the starts of
  // failure reports and one for every other error-shaped line.
  const half = Math.ceil(maxBlock / 2);
  const quarter = Math.floor((maxBlock - half) / 2);
  const early = new Map();
  const late = { start: new Map(), other: new Map() };
  let bucket = "other";
  const fd = openSync(logFile, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(64 * 1024);
  let carry = "";
  let carryCut = 0;
  let recent = [];
  let afterLeft = 0;

  const keep = (e) => {
    if (early.size < half) {
      early.set(e.n, e.text);
      return;
    }
    const window = late[bucket];
    if (early.has(e.n) || late.start.has(e.n) || late.other.has(e.n)) return;
    window.set(e.n, e.text);
    if (window.size > quarter) window.delete(window.keys().next().value);
  };

  const line = (raw, cut) => {
    out.total += 1;
    const plain = raw.replace(ANSI, "");
    // What is kept for display passes through `redact` (a line function, called on every line in order); what a line means is judged on `plain`.
    const shown = redact(plain);
    // Progress is counted and left out of everything shown; it never starts or extends a failure block.
    if (PROGRESS_LINE.test(plain) && !isFailureLine(plain)) {
      out.progress += 1;
      return;
    }
    const text = cut > 0 || shown.length > lineChars ? `${shown.slice(0, lineChars)} […${cut + Math.max(0, shown.length - lineChars)} more characters]` : shown;
    const entry = { n: out.total, text };
    if (out.total <= fullLines) out.head.push(entry);
    out.tail.push(entry);
    if (out.tail.length > tail) out.tail.shift();
    if (isWarningLine(plain)) {
      out.warnings += 1;
      if (out.firstWarning === "") out.firstWarning = text;
    }
    if (isFailureLine(plain)) {
      out.failures += 1;
      if (out.firstFailure === "") out.firstFailure = text;
      bucket = FAILURE_START.test(plain) ? "start" : "other";
      for (const e of recent) keep(e);
      keep(entry);
      afterLeft = after;
    } else if (afterLeft > 0) {
      keep(entry);
      afterLeft -= 1;
    }
    recent = [...recent, entry].slice(-before);
  };

  // Text arrives in pieces; a bare carriage return is a progress bar redrawing, so it ends a line like a newline does.
  let endedInCr = false;
  const feed = (piece) => {
    // A \r\n split between two pieces is one line break, not two.
    const text = endedInCr && piece.startsWith("\n") ? piece.slice(1) : piece;
    endedInCr = piece.endsWith("\r");
    const parts = (carry + text).replace(/\r\n/g, "\n").split(/[\n\r]/);
    carry = parts.pop() ?? "";
    for (const part of parts) {
      line(part, carryCut);
      carryCut = 0;
    }
    // Memory is fixed: a line that never ends is kept to its first lineChars characters and the rest is only counted.
    if (carry.length > lineChars * 2) {
      carryCut += carry.length - lineChars;
      carry = carry.slice(0, lineChars);
    }
  };

  try {
    out.bytes = fstatSync(fd).size;
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) feed(decoder.write(chunk.subarray(0, n)));
    feed(decoder.end());
    if (carry !== "") line(carry, carryCut);
  } finally {
    closeSync(fd);
  }
  out.blocks = new Map([...early, ...late.start, ...late.other]);
  return out;
};

// The lines to show for a failed command, in file order, as strings. A short log is whole; a long one is the failure blocks plus the tail,
// with a marker where lines are missing.
export const excerptLines = (scan) => {
  if (scan.total === 0) return ["(the command printed nothing)"];
  if (scan.total <= FULL_LOG_LINES) {
    const whole = scan.head.map((e) => e.text);
    return scan.progress > 0 ? [...whole, `… ${scan.progress} progress line${scan.progress === 1 ? "" : "s"} not shown …`] : whole;
  }
  const shown = new Map(scan.blocks);
  for (const e of scan.tail) shown.set(e.n, e.text);
  const numbers = [...shown.keys()].toSorted((a, b) => a - b);
  const lines = [];
  let last = 0;
  for (const n of numbers) {
    if (n > last + 1) lines.push(`… ${n - last - 1} line${n - last - 1 === 1 ? "" : "s"} not shown …`);
    lines.push(shown.get(n));
    last = n;
  }
  if (scan.total > last) lines.push(`… ${scan.total - last} line${scan.total - last === 1 ? "" : "s"} not shown …`);
  if (scan.failures === 0) lines.unshift("(no line names an error; the end of the output:)");
  // Markers add lines the 100 + 30 caps don't count; cut the middle (the first and last halves are the most useful) if they overflow.
  if (lines.length > EXCERPT_MAX_LINES) {
    const half = Math.floor((EXCERPT_MAX_LINES - 1) / 2);
    return [...lines.slice(0, half), `… ${lines.length - 2 * half} more lines not shown …`, ...lines.slice(-half)];
  }
  return lines;
};
