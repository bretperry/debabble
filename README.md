# debabble

Run a command with its whole output in a log file. When it passes, you get one line. When it fails,
you get an excerpt: the lines that name the failure, and the end of the output.

```
$ debabble -- pnpm test
log: …/debabble/app-3f2a/20261121-142201-pnpm-test.log
✓ pnpm test · 41.2s · log: …/debabble/app-3f2a/20261121-142201-pnpm-test.log
```

## Why

A test run or a build prints thousands of lines and one of them matters. Piping to `tail` hides a
failure that is not at the end, and `tee` loses order and bytes. debabble hands the command a log
file as stdout and stderr, so every byte lands in order, and reads the file afterwards.

## Use

```
debabble [--show verdict|excerpt] [--timeout <dur>] [--label <name>] [--log-dir <path>] -- <cmd> [args…]
```

- `--` is required. The command runs with the arguments you gave, with no shell.
- `--show excerpt` is for log readers (`gh run view --log`): a green run still lists its failure-shaped lines.
- `--timeout 30m` (default 30m; `90s`, `1500ms`, `2h`; a bare number is seconds). The whole process tree is stopped.
- Green lines also name the first warning and the first error-shaped line in the log, if any.
- The first line printed is always `log: <path>`, so a reader that only sees a backgrounded run's start still has the path.

Exit codes: the command's own; `128+n` when signal `n` ended it (also when debabble is killed;
it stops the command's tree and prints the log path first); `124` timed out; `125` usage error;
`126` / `127` the command cannot run / was not found.

When debabble is killed during a passthrough (`DEBABBLE=off` or CI), it first sends the same signal to the
command and everything it started, so the command can shut down as it would without debabble (Ctrl-C
cleanup, a CI cancel). Whatever is still running after 5 seconds (`DEBABBLE_KILL_GRACE_MS`), or at a
second signal, is stopped.

| Variable | Effect |
|---|---|
| `DEBABBLE=off` | Pass output straight through. The exit code stays exact. |
| `DEBABBLE_LOG_DIR` | Where logs go (default `$XDG_STATE_HOME/debabble`, else `~/.local/state/debabble`). |
| `DEBABBLE_TIMEOUT_MS` | Default timeout in milliseconds. |
| `DEBABBLE_KILL_GRACE_MS` | How long a killed passthrough's command has to exit before it is stopped (default 5000). |
| `CI`, `GITHUB_ACTIONS` | Pass output straight through (the CI log is the record there). |

Library: `import { run, scan, excerpt } from "debabble"`.

## Claude Code hook

```
debabble hook claude [--list <file>]
```

A PreToolUse hook on `Bash` that rewrites a noisy command to `debabble -- <the same line>`, so the
agent reads one line instead of the whole output. Settings entry: `{"type": "command", "command":
"debabble hook claude --list <file>", "timeout": 5}` under `PreToolUse` with matcher `Bash`.

It rewrites only when all of these hold; otherwise it prints nothing and the command runs as written:

- The line is one simple command: no `;`, `&&`, `||`, `|`, `&`, redirection, subshell, heredoc,
  `$(…)`, backticks, newline, comment, or leading `VAR=value`. Quoted operators are fine.
  It starts with a program, not a shell builtin or keyword (`cd`, `time`, `export`, `source`, `exec`, …).
- Its first words match an entry in the list file, and it is not already a `debabble` line.
- `DEBABBLE` is not `off`, and the call is not `run_in_background`.
- `bouncer` (shell-bouncer) and `debabble` are on `PATH`, each at or past its version in `requires`
  (read from the package's `package.json`, else from `<bin> --version` within 1 second).
  A list without both pins never rewrites.
- An allow rule in your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`),
  the project's `.claude/settings.json` or a `.claude/settings.local.json` (in the project folder, the repo root,
  or a worktree's main checkout) matches the rewritten line (for example `Bash(debabble -- pnpm test:*)`),
  and no deny or ask rule in those files or in the managed settings files matches either the rewritten or the original line.
  Claude Code checks allow rules against the rewritten line, so without that mirror the call would be refused.
- The hook can read every place a deny or ask rule could come from. Claude Code checks its rules against the
  rewritten line only, so a deny the hook can't see, such as `Bash(git push:*)`, would not match
  `debabble -- git push …`, and the push would run. So the hook never rewrites when any of these is true:
  - The `claude` running the hook, or a process between it and the hook, was started with a flag that brings settings,
    rules, agents, plugins or a permission judge: `--settings`, `--managed-settings`, `--client-data-url`, `--project-config-root`,
    `--allowedTools`, `--disallowedTools`, `--tools`, `--agents`, `--agent`, `--plugin-dir`, `--plugin-url`,
    `--input-format`, `--permission-prompt-tool` or `--permission-prompts`. Hosts that run Claude Code for you, such as the Claude
    desktop app and Agent SDK apps, pass these flags, so **the hook never rewrites in those sessions**.
    The hook reads the processes above it up to the nearest one it knows is `claude` (a `claude` binary, the desktop app's
    `claude.app`, or `node`/`bun` running the `@anthropic-ai/claude-code` package); what runs above that one, such as an outer
    `claude` session that ran `claude -p`, doesn't govern it. If it finds no `claude`, it checks every process up to the top.
  - It runs in a background session (`claude --bg`). Measured 2026-11-23 on claude 2.1.285: the session's host argv carries
    `--bg-spare` (the pty host's, `--bg-pty-host`), both read as rule flags, so the hook skips the rewrite. Claude Code strips its
    background variables from the hook's env except `CLAUDE_JOB_DIR`; when that is set, the hook checks every process up to the top.
  - A variable points Claude Code at settings the hook doesn't read: `CLAUDE_CODE_MANAGED_SETTINGS_PATH`,
    `CLAUDE_CODE_REMOTE_SETTINGS_PATH`, `CLAUDE_CODE_CLIENT_DATA_URL` or `CLAUDE_CODE_PLUGIN_DIRS`, among others.
  - A macOS MDM profile for Claude Code is installed, server-managed settings are cached
    (`remote-settings.json` in your user settings folder), or a managed settings file names a `policyHelper` or `policyHelpers`.
  - A settings file (user, project, local or managed) exists but can't be read or isn't a JSON object. A leading
    byte-order mark is fine; comments and trailing commas are not.
  - It runs on Windows or WSL, or it can't read the processes above it (it uses `/proc` on Linux and `ps` elsewhere).
    On Linux, argv is read from `/proc/<pid>/cmdline`; a claude that rewrites its process title would hide `--settings` (untested on Linux).

**The built-in default list is a no-op.** Its `requires` is empty, so `debabble hook claude` without
`--list` never rewrites anything. Pass `--list <file>` with both pins to turn the hook on.
Without `--list` the hook reads the shipped default under your own list file (see [Manage the wrap list](#manage-the-wrap-list)).
`--list <file>` reads that one file and skips the layering.

The rewrite adds only the prefix; the rest is the original line, byte for byte. Any error prints
nothing (the command runs unwrapped). The hook always exits 0; a usage error adds one line on stderr.

List file:

```json
{
  "requires": { "bouncer": "0.2.0", "debabble": "0.1.0" },
  "wrap": [
    { "match": "pnpm test", "show": "verdict" },
    { "match": "gh run view", "show": "excerpt" }
  ]
}
```

`match` is a word prefix: `pnpm test` matches `pnpm test --run x`, not `pnpm testx`. `show:
"excerpt"` rewrites to `debabble --show excerpt -- …`. `debabble --version` prints the version.

## Manage the wrap list

```
debabble list show
debabble list add <match> --show verdict|excerpt
debabble list disable <match>
debabble list enable <match>
```

You never edit JSON by hand. Your entries live in `$XDG_CONFIG_HOME/debabble/wrap.json` (default
`~/.config/debabble/wrap.json`), laid over the list that ships with debabble.

- `show` prints every entry with its source (`default` or `user`) and whether it is enabled.
- `add` puts a new entry in your file. It refuses a `match` that is empty, a shell builtin or keyword
  (`cd`, `export`, `if`, …), or holds a shell operator (`;`, `&`, `&&`, `|`, `||`, `<`, `>`, `$(`, a backtick,
  a newline). The hook wraps simple commands only. It also refuses a `match` already on the list.
- `disable` turns an entry off; `enable` turns it back on. Disabling a shipped entry writes an entry for it in your
  file with `"enabled": false`. There is no `remove`: you can switch a shipped entry off, never delete it.
- Your entry replaces a shipped entry with the same `match` (words compared with spaces collapsed); your other entries follow the shipped ones.
- `requires` (the version pins) stays in the shipped list; your file cannot change it.
- Writes are atomic (a temp file, then a rename). The file is `0600` and a folder debabble creates is `0700`.
- A file that is not valid JSON, or not `{"wrap": [...]}`, is reported with its path and left untouched.
  The hook rewrites nothing while your file is broken, so a command you disabled never runs wrapped.
- Exit codes: 0 done, 1 refused or not found or a broken file, 125 usage error.

## Redaction

What debabble prints (the `✓`/`✗` line, the excerpt, the label) has secret-shaped text masked as
`<redacted:shape>`. The log file is **not** touched: it holds the command's output byte for byte (mode
0600, on your machine). To see unmasked text, read the log path debabble prints.

Masked (high-precision shapes only):

| Shape | Looks like |
|---|---|
| `pem-private-key` | a `-----BEGIN … PRIVATE KEY-----` block through its END line, line by line, even when the excerpt shows only part of it |
| `github-token` | `gh` + one of `pousr` + `_` + 20 or more letters and digits |
| `sk-key` | `sk-` + 20 or more letters, digits, `-` or `_` |
| `aws-access-key` | `AKIA` + 16 capitals and digits |
| `slack-token` | `xox` + one of `abprs` + `-` + 10 or more letters, digits or `-` |
| `jwt` | `eyJ…` header, `eyJ…` payload, and the signature |
| `url-credentials` | the `user:pass` in `scheme://user:pass@host` (scheme and host stay) |

Not masked, on purpose: loose patterns such as `secret=…`, `token: …`, `Authorization: Bearer …` and
`.env`-style lines. They match source code and docs far more often than real secrets, and masking them
would mangle ordinary output. Other token formats (GitHub fine-grained `github_pat_…`, AWS `ASIA…`,
Stripe, Google) are not masked either. A secret that has no shape above reaches the excerpt as written,
and the library (`scan`, `excerpt`) masks nothing unless you pass it a redactor.

## Safety

- Logs can hold anything the command printed, secrets included (redaction masks only what debabble prints). They stay on your machine; nothing uploads them.
- The log folder is mode 0700 and each log 0600. At the start of each run debabble deletes its own
  logs older than 7 days and the oldest past 200 per folder.
- If the log folder can't be used (it isn't writable, or another user owns it), debabble prints one line on
  stderr naming the folder and the error, then logs to `debabble-<uid>` in your temp folder, which it prunes the same way.
  If the temp folder fails too, the line says so and the command runs with its output passed straight through, with no log.
- debabble never changes the exit code and never hides a failure behind a green line: a non-zero
  exit always prints an excerpt.

## Limits

- Node 22 or newer. No dependencies.
- A progress line (test dots, `ok pkg`) is never shown, and a line that names a failure is never counted as progress.
  Output that names no error is shown by its tail only.
- A process that was handed to init before a timeout is out of reach of the tree stop.
- If debabble is killed with SIGKILL it cannot clean up; the command may keep running.
- Windows is untested.
- Stdin is closed: not for interactive programs.

MIT licensed.
