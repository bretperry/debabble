// The library entry: the pieces debabble is built from, for a project that vendors them or tests against them.
// In the app: `import { run, scan, excerpt } from "debabble"`; the CLI (bin/debabble.mjs) uses the same modules. Additive only after 1.0.
// Used by: package consumers; tested by test/index.test.mjs.
// Uses: src/scan.mjs, src/run.mjs.
// Exports: run (command → promise of its result, output to a log file), scan (log file → counts and kept lines), excerpt (scan → lines to show).

export { run } from "./run.mjs";
export { scanLog as scan, excerptLines as excerpt } from "./scan.mjs";
