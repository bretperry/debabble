// Where a run's log lives: the per-repo log folder, the file name, permissions, and pruning of old logs.
// In the app: a library module; cli.mjs asks for a log file at the start of every run. Logs can hold secrets a command printed, so they never leave the machine.
// Used by: src/cli.mjs, src/index.mjs; tested by test/logs.test.mjs.
// Uses: node builtins only; the repo root is the nearest parent holding `.git` (falls back to the working directory).
// Exports: MAX_LOGS, MAX_AGE_DAYS, logBase(env, flag), repoRoot(cwd), logDirFor(cwd, env, flag), pruneLogs(dir, { now }), openLog(dir, label, { now, tmp }), slug(text).
//
// Layout: `<base>/<repo-basename>-<hash>/<YYYYMMDD-HHMMSS>-<label-slug>.log`, where <base> is `--log-dir`, else `DEBABBLE_LOG_DIR`, else
// `$XDG_STATE_HOME/debabble`, else `~/.local/state/debabble`. The folder is 0700 and each file 0600. Pruning runs at the start of each run:
// logs older than MAX_AGE_DAYS go, then the oldest past MAX_LOGS - 1 (the run about to start takes the last slot). Deleting old logs is this
// tool's documented retention; it only ever removes files whose names match its own pattern.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Most logs kept per folder, and how old a log may get, in days.
export const MAX_LOGS = 200;
export const MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// A log written by this tool: `20261121-142201-pnpm-test.log`, with an optional `-2` counter when two runs share a second and a label.
const LOG_NAME = /^\d{8}-\d{6}-.+\.log$/;

// A label as a file name part: letters, digits, . _ - only; at most 60 characters so the name stays short.
export const slug = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "run";

// The base folder for all repos' logs.
export const logBase = (env = process.env, flag) => {
  if (flag) return resolve(flag);
  if ((env.DEBABBLE_LOG_DIR ?? "") !== "") return resolve(env.DEBABBLE_LOG_DIR);
  const state = (env.XDG_STATE_HOME ?? "") !== "" ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "debabble");
};

// The repo's top folder: the nearest parent holding `.git` (a folder, or a file for a worktree), else `cwd`. Walked in JS: a `git` process
// would add about 10 ms to every run.
export const repoRoot = (cwd) => {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
};

// `<base>/<repo-basename>-<4 hex of the real path's hash>`: two repos named alike get different folders.
export const logDirFor = (cwd, env = process.env, flag) => {
  const root = repoRoot(cwd);
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that vanished: hash the name as given.
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 4);
  return join(logBase(env, flag), `${slug(basename(real)) || "root"}-${hash}`);
};

// Makes the folder (0700, parents included) and refuses a symlink or a folder someone else owns: a planted link would send logs elsewhere.
const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  // mkdir's mode is cut by the umask and skipped for a folder that already exists.
  chmodSync(dir, 0o700);
};

// Deletes this tool's logs in `dir` older than MAX_AGE_DAYS, then the oldest ones past MAX_LOGS - 1. Returns how many it removed.
// `now` is passed in so a test needs no clock. A folder that cannot be read or a file that cannot be removed is skipped, never an error.
export const pruneLogs = (dir, { now = Date.now(), maxLogs = MAX_LOGS, maxAgeDays = MAX_AGE_DAYS } = {}) => {
  let removed = 0;
  let logs = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!LOG_NAME.test(name)) continue;
      try {
        const info = statSync(join(dir, name));
        if (info.isFile()) logs.push({ name, at: info.mtimeMs });
      } catch {
        // Gone already.
      }
    }
  } catch {
    return 0;
  }
  const drop = (entry) => {
    try {
      rmSync(join(dir, entry.name), { force: true });
      removed += 1;
    } catch {
      // Read-only or busy: left for next time.
    }
  };
  const [old, fresh] = [logs.filter((e) => now - e.at > maxAgeDays * DAY_MS), logs.filter((e) => now - e.at <= maxAgeDays * DAY_MS)];
  for (const entry of old) drop(entry);
  logs = fresh.toSorted((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
  for (const entry of logs.slice(0, Math.max(0, logs.length - (maxLogs - 1)))) drop(entry);
  return removed;
};

const two = (n) => String(n).padStart(2, "0");
// `20261121-142201`, local time, so the name sorts the way a person reads the clock.
const stamp = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

// Prunes, then creates a new empty log (0600, never overwriting) for `label` in `dir`. Returns { logFile, dir, fallback }.
// If `dir` cannot be made or written, falls back rather than fail the run (the verdict matters more than where the log sits): to one reused
// folder per user in `tmp`, made and pruned like any log folder, else (someone else owns it) a fresh private one. `fallback` is then
// { dir: the folder it could not use, error: why } for the caller to say so; otherwise null.
export const openLog = (dir, label, { now = Date.now(), tmp = tmpdir() } = {}) => {
  let target = dir;
  let fallback = null;
  try {
    ensureDir(dir);
    pruneLogs(dir, { now });
  } catch (error) {
    fallback = { dir, error: error.code ?? error.message };
    target = join(tmp, `debabble-${typeof process.getuid === "function" ? process.getuid() : "logs"}`);
    try {
      ensureDir(target);
      pruneLogs(target, { now });
    } catch {
      target = mkdtempSync(join(tmp, "debabble-"));
    }
  }
  for (let n = 1; n < 1000; n += 1) {
    const logFile = join(target, `${stamp(now)}-${slug(label)}${n === 1 ? "" : `-${n}`}.log`);
    try {
      // "wx": two runs in the same second never share a file.
      closeSync(openSync(logFile, "wx", 0o600));
      return { logFile, dir: target, fallback };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no free log name in ${target}`);
};
