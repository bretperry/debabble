// Tests for src/scan.mjs: what counts as progress, what counts as a failure, and how a log is cut.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/scan.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXCERPT_MAX_LINES, TAIL_LINES, excerptLines, isProgressLine, scanLog } from "../src/scan.mjs";

const logWith = (text) => {
  const file = join(mkdtempSync(join(tmpdir(), "scan-")), "x.log");
  writeFileSync(file, text);
  return file;
};

// One real progress line per common runner (measured 2026-10-29).
const PROGRESS = [
  "....................",
  "·······",
  "tests/test_a.py ....s.x  [ 40%]",
  "...s.  [100%]",
  " ✓ src/a.test.ts (12 tests) 34ms",
  " ✓ src/a.test.ts (12 tests | 2 skipped)",
  "✔ adds two numbers (1.2425ms)",
  "ok  \tex/b\t0.507s",
  "ok  \tex/b\t(cached)",
  "?   \tex/c\t[no test files]",
  "=== RUN   TestOK",
  "    --- PASS: TestOK/sub (0.00s)",
  "--- SKIP: TestSlow (0.00s)",
  "        PASS [   0.012s] nx::tests a",
  "   Compiling nx v0.1.0 (/tmp/nx)",
  "test_a (mod.Class.test_a) ... ok",
];
// Lines that mean something went wrong, or might: never progress, even when they look like it.
const NOT_PROGRESS = [
  "..........X.....",
  "..F...",
  "tests/test_a.py ..F.  [ 50%]",
  "·····x·",
  " ❯ src/a.test.ts (6 tests | 1 failed) 5ms",
  "   × bad 4ms",
  "✖ harness-eject.test.mjs (1.0ms)",
  "--- FAIL: TestBad (0.00s)",
  "FAIL\tex/a\t0.272s",
  "        FAIL [   0.027s] (2/2) nx b",
  "test_b (mod.Class.test_b) ... FAIL",
  "test_c (mod.Class.test_c) ... ERROR",
  "ok  \tex/b\t0.5s FAIL: leaked goroutine",
  "    a_test.go:6: boom",
  "Error: something",
  "",
  "   at Test.run (node:internal/test_runner/test:1397:25)",
];

describe("progress lines", () => {
  it("isProgressLine drops every runner's progress shape and keeps anything that marks or names a failure", () => {
    for (const line of PROGRESS) assert.equal(isProgressLine(line), true, JSON.stringify(line));
    for (const line of NOT_PROGRESS) assert.equal(isProgressLine(line), false, JSON.stringify(line));
  });

  it("no progress shape can hide a failure: with a failure word added to any of them, the line is kept", () => {
    for (const line of PROGRESS) {
      for (const word of ["error", "Error", "FAIL", "failed", "panic:", "✖", "timed out", "Traceback"]) {
        assert.equal(isProgressLine(`${line} ${word}`), false, `${line} ${word}`);
        assert.equal(isProgressLine(`${word} ${line}`), false, `${word} ${line}`);
      }
    }
  });

  it("scanLog counts progress lines and leaves them out of the excerpt, short logs and long ones, keeping line numbers", () => {
    const short = scanLog(logWith(`${PROGRESS.join("\n")}\nFAIL the real one\n`));
    assert.equal(short.progress, PROGRESS.length);
    assert.deepEqual(excerptLines(short), ["FAIL the real one", `… ${PROGRESS.length} progress lines not shown …`]);
    const long = scanLog(logWith(`${[...Array.from({ length: 500 }, () => "...................."), "..........X.....", "✖ failing tests:", "Error: boom"].join("\n")}\n`));
    assert.equal(long.progress, 500);
    const text = excerptLines(long);
    assert.ok(text.includes("..........X....."));
    assert.ok(text.includes("Error: boom"));
    assert.equal(text.filter((line) => /^\.+$/.test(line)).length, 0);
    assert.ok(text.some((line) => /^… 500 lines not shown …$/.test(line)) || text.length < 10, JSON.stringify(text));
  });
});

describe("what counts as a failure", () => {
  it("a green log that builds hyphenated crates or paths named error/timeout does not look like it failed", () => {
    const scan = scanLog(logWith("Compiling quick-error v1.0\nCompiling wait-timeout v0.2\nsrc/error.ts ok\n0 errors, 0 failures\n"));
    assert.equal(scan.failures, 0);
  });

  it("an error class by name counts (TypeError, ModuleNotFoundError), even though the word boundary sees no break inside it", () => {
    for (const line of ["TypeError: x is not a function", "ModuleNotFoundError: No module named 'a'", "java.lang.NullPointerException"]) assert.equal(scanLog(logWith(`${line}\n`)).failures, 1, line);
  });

  it("'2 failed, 0 errors' still counts, '0 errors' alone does not", () => {
    assert.equal(scanLog(logWith("2 failed, 0 errors\n")).failures, 1);
    assert.equal(scanLog(logWith("0 errors\n")).failures, 0);
  });

  it("strips terminal operating-system commands (window titles, hyperlinks) as well as colors from the excerpt", () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const scan = scanLog(logWith(`${esc}]0;title${bel}${esc}[31mError: red${esc}[0m ${esc}]8;;http://x${esc}\\link${esc}]8;;${esc}\\\n`));
    assert.deepEqual(excerptLines(scan), ["Error: red link"]);
  });
});

describe("cutting a log", () => {
  it("a short log is whole; a long one keeps failure blocks and the tail, in file order, gaps marked", () => {
    const rows = Array.from({ length: 400 }, (_, i) => (i === 100 ? "FAIL src/a.test.ts > mid failure" : `row ${i}`));
    const text = excerptLines(scanLog(logWith(`${rows.join("\n")}\n`)));
    assert.ok(text.includes("FAIL src/a.test.ts > mid failure"));
    assert.equal(text.at(-1), "row 399");
    assert.ok(text.some((line) => /^… \d+ lines? not shown …$/.test(line)));
    assert.deepEqual(excerptLines(scanLog(logWith("a\nb\nc\n"))), ["a", "b", "c"]);
  });

  it("with output that names no error, shows the end of it and says so; with no output, says that", () => {
    const text = excerptLines(scanLog(logWith(`${Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n")}\n`)));
    assert.equal(text[0], "(no line names an error; the end of the output:)");
    assert.ok(text.includes("row 299") && text.includes(`row ${300 - TAIL_LINES}`) && !text.includes("row 5"));
    assert.deepEqual(excerptLines(scanLog(logWith(""))), ["(the command printed nothing)"]);
  });

  it("a real failure after a flood of early error lines still shows (kept lines are split between the first and the latest)", () => {
    const rows = [...Array.from({ length: 150 }, (_, i) => `console.error: early noise ${i}`), ...Array.from({ length: 400 }, (_, i) => `filler ${i}`), "FAIL src/real.test.ts > the real failure", ...Array.from({ length: 10 }, (_, i) => `detail ${i}`)];
    assert.ok(excerptLines(scanLog(logWith(`${rows.join("\n")}\n`))).includes("FAIL src/real.test.ts > the real failure"));
  });

  it("a failure report is not pushed out by a flood of generic error-shaped lines after it", () => {
    const rows = ["FAIL src/x.test.ts > the report", "AssertionError: 1 == 2", ...Array.from({ length: 300 }, (_, i) => `retry error ${i}: connection refused`)];
    const text = excerptLines(scanLog(logWith(`${rows.join("\n")}\n`)));
    assert.ok(text.includes("FAIL src/x.test.ts > the report"));
  });

  it("the excerpt never exceeds EXCERPT_MAX_LINES, whatever the log holds", () => {
    // Every other line fails, so the kept blocks and the gap markers between them are as many as they can be.
    const rows = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `Error: boom ${i}` : `row ${i}`));
    assert.ok(excerptLines(scanLog(logWith(`${rows.join("\n")}\n`))).length <= EXCERPT_MAX_LINES);
  });

  it("a line longer than the cut is cut in the excerpt and says how much; a carriage-return redraw ends a line", () => {
    const scan = scanLog(logWith(`Error: ${"y".repeat(5000)}\nprogress 1\rprogress 2\rError: done\n`));
    assert.match(excerptLines(scan)[0], /\[…\d+ more characters\]$/);
    assert.equal(scan.total, 4);
  });

  it("memory stays fixed for a log of 60 MB with one 20 MB line (heap growth under 60 MB)", () => {
    const file = logWith("");
    const chunk = `${"filler line ".repeat(8)}\n`.repeat(1000);
    writeFileSync(file, `${chunk.repeat(400)}${"z".repeat(20_000_000)}\nError: at the end\n`);
    if (globalThis.gc) globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const scan = scanLog(file);
    const grew = process.memoryUsage().heapUsed - before;
    assert.ok(scan.total > 400_000);
    assert.ok(grew < 60 * 1024 * 1024, `heap grew ${grew}`);
    assert.ok(excerptLines(scan).includes("Error: at the end"));
  });
});
