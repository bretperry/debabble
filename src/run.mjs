// Runs one command with its whole output (stdout and stderr, in order) sent to a log file, and stops its process tree on timeout or kill.
// In the app: the I/O edge of the library; cli.mjs is the only caller that matters.
// Used by: src/cli.mjs, src/index.mjs; tested by test/run.test.mjs.
// Uses: node builtins only; `ps` to walk a process tree (without it, only the root is stopped).
// Exports: DEFAULT_TIMEOUT_MS, MAX_TIMER_MS, signalTree(root, signal), stopTree(root), run({ command, args, cwd, logFile, env, timeoutMs }).
//
// Why the child writes the file itself: stdout and stderr are the same open file, handed to the command as fd 1 and fd 2. The kernel orders
// the writes, so `2>&1` order is kept exactly, and nothing sits in a pipe or a buffer of ours, so a command that writes megabytes and calls
// `process.exit` loses nothing. A relay in between (a tee) broke both; this is the shape that doesn't.
//
// A command that outlives its limit is stopped with everything it started: on timeout the tree is frozen (SIGSTOP, walked until it stops
// growing) and SIGKILLed. Not a process group: a new session would take the command's controlling terminal (/dev/tty) away. No supervisor
// process sits between debabble and the command, so a run costs one process start, not two. Limit: a process already handed to init (its
// parent exited) before the timeout is out of reach.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

// A command that runs longer than this is killed and reported as timed out.
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// The most a timer can wait: setTimeout treats a longer delay as 1 ms, which would kill every command at once.
export const MAX_TIMER_MS = 2 ** 31 - 1;
// How many times stopTree walks the tree looking for processes started since the last walk, at most.
const MAX_WALKS = 200;

// The ids of `root` and everything it started, as `ps` lists them now. Without `ps` (Windows), just the root.
const treeOf = (root) => {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return [root];
  const children = new Map();
  for (const row of listed.stdout.split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = [];
  for (const queue = [root]; queue.length > 0; ) {
    const pid = queue.shift();
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
};

const signalAll = (pids, signal) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

// Sends `signal` to `root` and every process it started, as `ps` lists them now (the passthrough's graceful stop; stopTree follows).
export const signalTree = (root, signal) => signalAll(treeOf(root), signal);

// Stops `root` and every process it started that is still attached to it: SIGSTOP the tree, walk it again, and repeat until a walk finds
// nothing new, then SIGKILL all of it. A stopped process cannot fork, so a spawner forking every few milliseconds cannot outrun the walk
// (killing first would leave the children it forked between the listing and its own death). No SIGTERM first: a process that has
// been told to clean up would keep forking while it does.
export const stopTree = (root) => {
  const seen = new Set();
  for (let walk = 0; walk < MAX_WALKS; walk += 1) {
    const fresh = treeOf(root).filter((pid) => !seen.has(pid));
    if (fresh.length === 0) break;
    signalAll(fresh, "SIGSTOP");
    for (const pid of fresh) seen.add(pid);
  }
  signalAll([...seen], "SIGKILL");
};

// Runs `command args` in `cwd` with stdout and stderr both appended to `logFile` (which must exist); the command reads no input. With no
// `logFile`, the command shares debabble's stdin, stdout and stderr instead (the passthrough).
// Returns a promise of { status, signal, timedOut, error, ms }: status is the exit code (null when a signal ended it). The promise has a
// `child` property (the command's process), so a caller can stop the tree on a kill (stopTree(promise.child.pid)).
export const run = ({ command, args = [], cwd, logFile, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  const fd = logFile === undefined ? null : openSync(logFile, "a");
  const started = Date.now();
  const child = spawn(command, args, { cwd, env, stdio: fd === null ? "inherit" : ["ignore", fd, fd] });
  if (fd !== null) closeSync(fd);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopTree(child.pid);
  }, Math.min(timeoutMs, MAX_TIMER_MS));
  const done = new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      resolve({ timedOut, ...result, ms: Date.now() - started });
    };
    // A command that could not start (not found, not executable) emits `error` and never `exit`.
    child.on("error", (error) => finish({ status: null, signal: null, error: timedOut ? undefined : error }));
    child.on("exit", (status, signal) => finish({ status, signal }));
  });
  return Object.assign(done, { child });
};
