// Shared test helpers: a clean environment, a temp log folder, and a way to run the CLI as a person's shell does.
// In the app: nothing at runtime; imported by the *.test.mjs files here.
// Used by: test/cli.test.mjs, test/run.test.mjs, test/logs.test.mjs.
// Uses: node builtins only.
// Exports: BIN, tmp(label), cleanEnv(extra), cli(args, { env, cwd }), logPathOf(stdout).

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "debabble.mjs");

// A fresh empty folder; `label` may hold a space so path handling is exercised.
export const tmp = (label = "dbb") => mkdtempSync(join(tmpdir(), `${label} `));

// The environment of a plain shell: no CI flags, no opt-out, logs in a throwaway folder.
export const cleanEnv = (extra = {}) => ({ ...process.env, CI: "", GITHUB_ACTIONS: "", DEBABBLE: "", DEBABBLE_TIMEOUT_MS: "", DEBABBLE_LOG_DIR: tmp("logs"), ...extra });

// Runs `debabble <args>` and returns { status, stdout, stderr, lines }.
export const cli = (args, { env = cleanEnv(), cwd = tmp("cwd") } = {}) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, lines: result.stdout.split("\n").filter(Boolean), env };
};

// The path on the first `log: ` line.
export const logPathOf = (stdout) => /^log: (.+)$/m.exec(stdout)?.[1];
