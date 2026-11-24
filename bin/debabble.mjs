#!/usr/bin/env node
// The `debabble` executable: `hook …` goes to src/hook.mjs, `list …` to src/list.mjs, `--version` prints the package version, anything else to src/cli.mjs; exits with its code.
// Run: `debabble [--show verdict|excerpt] [--timeout <dur>] [--label <name>] [--log-dir <path>] -- <cmd> [args…]`, `debabble hook claude [--list <file>]`, `debabble list show|add|disable|enable …`, `debabble --version`.
// When: see src/cli.mjs and src/hook.mjs.
// Env: see src/cli.mjs and src/hook.mjs.
// Writes: see src/cli.mjs and src/hook.mjs.
// Exit: see src/cli.mjs; the hook always exits 0; --version 0.
// Used by: npm's bin link.

// Each path imports only what it needs: the hook runs on every Bash call, so it must not load the runner.
const argv = process.argv.slice(2);
if (argv[0] === "hook") {
  // Fail open: a broken install (a missing or bad src/hook.mjs) prints nothing and exits 0, so the command runs unwrapped.
  try {
    const { readFileSync } = await import("node:fs");
    const { hookMain } = await import("../src/hook.mjs");
    const result = hookMain(argv.slice(1), { stdin: () => readFileSync(0, "utf8") });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  } catch {}
  process.exitCode = 0;
} else if (argv[0] === "list") {
  const { listMain } = await import("../src/list.mjs");
  const result = listMain(argv.slice(1));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.code;
} else if (argv.length === 1 && argv[0] === "--version") {
  const { readFileSync } = await import("node:fs");
  process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}\n`);
} else {
  const { main } = await import("../src/cli.mjs");
  // process.exit, not a returned code: a command that left a handle open must not keep the wrapper alive.
  process.exit(await main(argv));
}
