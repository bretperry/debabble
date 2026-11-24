// The Claude Code hook: rewrites a noisy Bash call on the wrap list to `debabble [--show excerpt] -- <original>`, and leaves every other call alone.
// In the app: bin/debabble.mjs runs `hookMain` for `debabble hook claude [--list <file>]`; Claude Code runs that as a PreToolUse hook on `Bash`.
// Run: Claude Code pipes the hook JSON on stdin; settings entry: `{"type":"command","command":"debabble hook claude","timeout":5}` under PreToolUse, matcher `Bash`.
// When: every Bash call in a project that wires it.
// Env: DEBABBLE=off (no rewrite); CLAUDE_PROJECT_DIR (where project settings are read; else the hook JSON's `cwd`); HOME; CLAUDE_CONFIG_DIR (the user
//   settings folder, else ~/.claude); PATH (where `bouncer` and `debabble` are looked up); any RULE_ENV variable set (no rewrite).
// Writes: nothing but stdout: either nothing (no rewrite) or one JSON line with `updatedInput`. Never a `permissionDecision`.
// Exit: 0 always (a usage error prints one line on stderr). Any other error prints nothing, so Claude Code runs the original command (costs tokens, never safety).
// Used by: bin/debabble.mjs; tested by test/hook.test.mjs.
// Uses: node builtins only; src/list.mjs (the shipped default under the user file) when no `--list` is given; `ps` (not on Linux) to read the argv of the processes above the hook,
//   up to the nearest `claude` (CLAUDE_HOST).
// Exports: readLine(line), wordPrefix(words, match), matchRule(pattern, line, mode), decide(line, list, env, facts), processInfo(pid), claudeHost(args),
//   flaggedAncestor(start, stop, info, { atHost }), blindSpot(env, configDir, system), ancestorBlindSpot(system, stop, env), gatherFacts(input, env, system), hookOutput(input, command),
//   hookMain(argv, { stdin, env, system, stopPid }) (system and stopPid: tests only).
//
// A rewrite needs every one of these (anything else, or any doubt: no rewrite):
// - the line is one simple command: no `;` `&&` `||` `|` `&`, redirection, subshell, heredoc, `$(…)` or backticks, newline, comment, or leading `VAR=x`,
//   and it starts with a program, not a shell builtin or keyword (`cd`, `time`, `export`, `source`, `exec`, …);
// - its words start with a list entry's `match` words, and it is not already a debabble line;
// - DEBABBLE is not `off`; the call is not `run_in_background`;
// - `bouncer` and `debabble` are on PATH (version from their package.json, else `--version`), each at or past its pin in the list's `requires` (a missing pin counts as not met);
// - an allow rule in the user or project settings matches the rewritten line (the mirror), and no deny or ask rule matches either line;
// - every place Claude Code may take a deny or ask rule from is one the hook reads (blindSpot, ancestorBlindSpot): Claude Code checks its rules against the rewritten
//   line only, so a deny the hook cannot see (`Bash(git push:*)` in an MDM profile or `--settings`) would not match `debabble -- git push …`.
// The rewrite is the prefix plus the exact original bytes, so the line the guard judged is the line that runs inside the wrapper.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { NOT_PROGRAMS, readLayered } from "./list.mjs";

export { NOT_PROGRAMS };

// The programs whose versions gate a rewrite, and the npm package each belongs to (to find its package.json from the bin on PATH).
export const REQUIRED = { bouncer: "shell-bouncer", debabble: "debabble" };
const PACKAGE_DEPTH = 6;
// The fallback `<bin> --version` (only when no package.json is found, as behind a pnpm, Volta or asdf shim) gives up after this long: no version, no rewrite.
const VERSION_TIMEOUT_MS = 1000;
const USAGE = "usage: debabble hook claude [--list <file>]";
// Where Claude Code reads managed settings files (`managed-settings.json` and `managed-settings.d/*.json`), per platform. Elsewhere (Windows,
// whose policy also sits in the registry): no rewrite.
const MANAGED_DIRS = { darwin: "/Library/Application Support/ClaudeCode", linux: "/etc/claude-code" };
// A macOS MDM profile for Claude Code, machine-wide or per user. A plist needs a process to read, so one existing is enough for no rewrite.
const MDM_DOMAIN = "com.anthropic.claudecode.plist";
// Flags on a process the walk reads (the hook's ancestors up to the `claude` that runs it; all of them when none is recognized) that bring rules or a judge the hook cannot read,
// from `claude --help` and the flags claude 2.1.285 parses (hidden ones included). Any of them, alone or as `--flag=value`: no rewrite.
// - settings: `--settings`; `--managed-settings` (hidden; policy-tier settings from an SDK host); `--client-data-url` (a signed configuration
//   document); `--project-config-root` (project settings read from another folder than the one the hook reads).
// - tool lists: `--allowedTools`, `--disallowedTools` (either spelling) and `--tools`, which Claude Code groups with them.
// - agents and plugins: `--agents`, `--agent`, `--plugin-dir`, `--plugin-dir-no-mcp`, `--plugin-url` bring definitions the hook doesn't read,
//   and an agent definition carries its own tool denies.
// - a judge of the rewritten line: `--input-format` (an SDK host, which can also pass settings on stdin), `--permission-prompt-tool`, `--permission-prompts`.
// - a background session: `--bg`, `--background`, and the workers that run it (`--daemon-worker`, `--bg-spare`, `--bg-pty-host`), which take
//   the session's flags over a socket, not argv.
// Not rule flags: `--setting-sources` (only narrows what is read), `--permission-mode` (a deny rule holds in every mode), `--restricted` (drops
// the user, project and local files, keeps managed settings and `--settings`), `--add-dir` (2.1.285 reads no settings file from an added folder).
const RULE_FLAG_NAMES = [
  "settings", "managed-settings", "client-data-url", "project-config-root",
  "allowedTools", "allowed-tools", "disallowedTools", "disallowed-tools", "tools",
  "agents", "agent", "plugin-dir", "plugin-dir-no-mcp", "plugin-url",
  "input-format", "permission-prompt-tool", "permission-prompts",
  "bg", "background", "daemon-worker", "bg-spare", "bg-pty-host",
];
const RULE_FLAGS = new RegExp(`(?:^|\\s)--(?:${RULE_FLAG_NAMES.join("|")})(?=[=\\s]|$)`);
// Variables in the hook's env (it inherits claude's) that point Claude Code at settings the hook doesn't read: a managed settings path, a
// server-managed settings file or mock, a signed configuration document, settings handed down by a bridge host, plugin folders (as
// `--plugin-dir`). Any of them set: no rewrite.
const RULE_ENV = [
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH", "CLAUDE_CODE_MOCK_REMOTE_SETTINGS", "CLAUDE_CODE_CLIENT_DATA_URL",
  "CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS", "CLAUDE_CODE_PLUGIN_DIRS",
];
// The ancestor walk gives up (no rewrite) past this many processes, and each `ps` after this long.
const MAX_ANCESTORS = 64;
// The `claude` host process, by its argv as `ps -o args=` (or /proc cmdline) joins it: the walk stops there, since its flags govern this
// session's tool calls and what sits above it (a parent claude, an IDE, a shell, a desktop app) does not. Observed on macOS, 2026-11-23:
// claude 2.1.285 from a terminal runs a hook's shell as its direct child, argv0 as typed (`/opt/homebrew/bin/claude -p …`, or bare `claude`);
// the desktop app runs `<…>/Application Support/Claude/claude-code/<version>/<id>/claude.app/Contents/MacOS/claude <flags>` (2.1.326) under
// `disclaimer --pgroup -- <that path> <flags>`, which the strict patterns below don't take for claude. Each pattern reads argv0 with no
// space in it (the desktop path's one `Application Support` aside), so an argument that merely names claude never matches. An npm install
// run through its bin link (`node /usr/local/bin/claude`) is not recognized: the walk then goes to the top, as before.
const CLAUDE_HOST = [
  /^(?:[^ ]*\/)?claude(?: |$)/,
  /^\/[^ ]*(?:\/Application Support\/[^ ]*)?\/claude\.app\/Contents\/MacOS\/claude(?: |$)/,
  /^(?:[^ ]*\/)?(?:node|bun) (?:[^ ]*\/)?node_modules\/@anthropic-ai\/claude-code\/(?:cli\.js|bin\/claude)(?: |$)/,
];
// A background session (`claude --bg`). Measured 2026-11-23, claude 2.1.285, a real `claude --bg --settings <deny>` session: the session's host
// argv carries `--bg-spare` and the pty host's carries `--bg-pty-host`, both rule flags, so the walk finds them and the hook skips the rewrite.
// claude strips CLAUDE_CODE_SESSION_KIND, CLAUDE_BG_BACKEND, CLAUDE_BG_SOURCE and CLAUDE_BG_SESSION_PERMISSION_RULES from the env it gives hooks;
// CLAUDE_JOB_DIR is the one that survives. Set, the walk ignores the claude host and goes to the top.
const BACKGROUND_ENV = ["CLAUDE_JOB_DIR"];
const PS_TIMEOUT_MS = 1000;

// Reads a shell line as one simple command: its words, unquoted, or null when it is anything else (or when in doubt).
export const readLine = (line) => {
  // A newline anywhere (two commands, a continuation, a quoted multi-line argument) is doubt enough.
  // So are other line or paragraph separators and control characters (tab aside): what a reader shows as one line must be one line.
  if (typeof line !== "string" || /[\n\r\u0085\u2028\u2029\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) return null;
  const words = [];
  const raw = [];
  let word = null; // the unquoted text of the word being read; null between words
  let start = 0;
  const begin = (at) => {
    if (word === null) {
      word = "";
      start = at;
    }
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      if (word !== null) {
        words.push(word);
        raw.push(line.slice(start, i));
        word = null;
      }
      continue;
    }
    if (";&|<>()`\n\r".includes(ch)) return null;
    if (ch === "#" && word === null) return null;
    if (ch === "$" && line[i + 1] === "(") return null;
    begin(i);
    if (ch === "\\") {
      if (i + 1 >= line.length) return null;
      word += line[(i += 1)];
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      word += line.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j += 1) {
        const c = line[j];
        if (c === "`" || (c === "$" && line[j + 1] === "(")) return null;
        if (c === "\\") {
          if (j + 1 >= line.length) return null;
          j += 1;
          word += '$`"\\\n'.includes(line[j]) ? line[j] : `\\${line[j]}`;
        } else word += c;
      }
      if (j >= line.length) return null;
      i = j;
    } else word += ch;
  }
  if (word !== null) {
    words.push(word);
    raw.push(line.slice(start));
  }
  if (words.length === 0) return null;
  // A leading assignment would be run by debabble as a program name (no shell), so the line is not one it can wrap.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[0])) return null;
  return words;
};

// Whether `words` start with the words of `match` (`pnpm test` matches `pnpm test --run x`, not `pnpm testx`).
export const wordPrefix = (words, match) => {
  const want = match.trim().split(/\s+/);
  return want.length > 0 && want[0] !== "" && want.length <= words.length && want.every((w, i) => words[i] === w);
};

// Whether a permission rule's content (the text inside `Bash(…)`) matches a command line.
// mode "strict" (for allow: a false match would send a line the rules then deny) or "loose" (for deny and ask: a false match only skips a rewrite).
export const matchRule = (pattern, line, mode) => {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return mode === "strict" ? line === prefix || line.startsWith(`${prefix} `) : line.startsWith(prefix);
  }
  if (!pattern.includes("*")) return line === pattern;
  let source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  // `Bash(ls *)` may also match a bare `ls`; count that only where a false match is harmless.
  if (mode === "loose") source = source.replace(/ \.\*$/, "(?: .*)?");
  return new RegExp(`^${source}$`, "s").test(line);
};

// Compares dotted versions with an optional prerelease (`1.2.3-pre.1` < `1.2.3`): negative, zero, or positive; NaN when either is not a version.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const compareVersions = (a, b) => {
  const [x, y] = [VERSION.exec(String(a ?? "")), VERSION.exec(String(b ?? ""))];
  if (!x || !y) return Number.NaN;
  for (let i = 1; i <= 3; i += 1) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0);
  const [p, q] = [x[4].split("."), y[4].split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const [n, m] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (n && m && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
};

const isDebabble = (word) => word === "debabble" || word.endsWith("/debabble");

// The pure core: the rewritten command, or null for no rewrite.
// facts: { background, versions: { bouncer, debabble }, rules: { allow, deny, ask } (rule contents of `Bash(…)` entries), blind (a reason, or null) }.
export const decide = (line, list, env, facts) => {
  if (env.DEBABBLE === "off" || facts.background !== false || facts.blind !== null) return null;
  const words = readLine(line);
  if (!words || isDebabble(words[0]) || NOT_PROGRAMS.has(words[0])) return null;
  const entry = (list?.wrap ?? []).find((e) => typeof e?.match === "string" && e.enabled !== false && wordPrefix(words, e.match));
  if (!entry) return null;
  for (const bin of Object.keys(REQUIRED)) if (!(compareVersions(facts.versions?.[bin], list.requires?.[bin]) >= 0)) return null;
  const command = `debabble ${entry.show === "excerpt" ? "--show excerpt " : ""}-- ${line}`;
  const { allow = [], deny = [], ask = [] } = facts.rules ?? {};
  // A deny or ask rule on either line keeps the original, so Claude Code judges it as written (an allow on the rewrite must never outrank a deny on the original).
  // The original is matched as written and as its words joined by one space, so a respelling (`ssh  'prod' x`) cannot slip past `Bash(ssh prod:*)`.
  const spellings = [command, line, line.trim(), words.join(" ")];
  if ([...deny, ...ask].some((p) => spellings.some((text) => matchRule(p, text, "loose")))) return null;
  return allow.some((p) => matchRule(p, command, "strict")) ? command : null;
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// The version of the package that owns `bin` on PATH, read from its package.json (no process started), or null.
const versionOnPath = (bin, pkgName, env) => {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      let at = dirname(realpathSync(candidate));
      for (let i = 0; i < PACKAGE_DEPTH; i += 1) {
        const pkg = readJson(join(at, "package.json"));
        if (pkg?.name === pkgName) return typeof pkg.version === "string" ? pkg.version : null;
        at = dirname(at);
      }
      return versionFromRun(candidate);
    } catch {}
  }
  return null;
};

// `<path> --version`, first line, when it is a version; null on anything else (a timeout included).
const versionFromRun = (path) => {
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const first = out.trim().split("\n")[0].trim().replace(/^v/, "");
    return Number.isNaN(compareVersions(first, "0.0.0")) ? null : first;
  } catch {
    return null;
  }
};

// A settings file as Claude Code reads it: null when it is not there, else its JSON object, a leading UTF-8 BOM dropped (Claude Code drops
// it and applies the rules). Throws when the file exists but can't be read, isn't JSON or isn't an object, so the caller skips the rewrite.
// Claude Code 2.1.285 ignores a file with comments or trailing commas, so "no rules" would also be safe there; skipping is safe either way.
const readSettings = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const json = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error(`${path} is not a settings object`);
  return json;
};

// `Bash(…)` rule contents from the settings files, by kind; throws (readSettings) when one exists but can't be read.
const bashRules = (files) => {
  const rules = { allow: [], deny: [], ask: [] };
  for (const file of files) {
    const perms = readSettings(file)?.permissions;
    for (const kind of Object.keys(rules)) {
      for (const rule of Array.isArray(perms?.[kind]) ? perms[kind] : []) {
        const m = typeof rule === "string" ? /^Bash\((.*)\)$/s.exec(rule.trim()) : null;
        if (m) rules[kind].push(m[1]);
      }
    }
  }
  return rules;
};

// Whether `path` exists: false only when it is not there; any other failure (no permission) throws, so the caller treats it as unread.
const present = (path) => {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
};

// One process: { ppid, args } (args joined by spaces), or null. Linux reads /proc (no process started); elsewhere one `ps` per process.
export const processInfo = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …`; comm may hold spaces and parentheses, so read from the last `)`.
    return { ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ") };
  } catch {}
  try {
    const out = execFileSync("ps", ["-ww", "-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: PS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const match = /^\s*(\d+)\s?([\s\S]*)$/.exec(out);
    return match ? { ppid: Number(match[1]), args: match[2] } : null;
  } catch {
    return null;
  }
};

// Whether a process's args (argv joined by spaces) are the `claude` host's (CLAUDE_HOST).
export const claudeHost = (args) => CLAUDE_HOST.some((pattern) => pattern.test(args));

// Why a process from `start` up to the nearest claude host (CLAUDE_HOST; to pid 1 when none is recognized, or `atHost` is false; stopping
// before `stop`) may hold rules the hook cannot read: a RULE_FLAGS flag on it, or a walk that could not finish (a process that cannot be
// read, a loop, too many). Null when every one was read and none has such a flag. The host's own flags count; a claude inside a claude
// (`claude -p` from a session's Bash) is the nearest, so its flags govern and the outer one's are not read.
// `info(pid)` → { ppid, args } or null.
export const flaggedAncestor = (start, stop, info, { atHost = true } = {}) => {
  const seen = new Set();
  for (let pid = start; pid >= 1 && pid !== stop; ) {
    if (seen.has(pid) || seen.size >= MAX_ANCESTORS) return "the process tree above the hook could not be walked";
    seen.add(pid);
    const proc = info(pid);
    if (!proc || !Number.isInteger(proc.ppid) || typeof proc.args !== "string") return `process ${pid} could not be read`;
    if (RULE_FLAGS.test(proc.args)) return `process ${pid} was started with a rule flag`;
    if (pid === 1 || (atHost && claudeHost(proc.args))) break;
    pid = proc.ppid;
  }
  return null;
};

// The managed settings files Claude Code reads in `dir`, in its order; throws when one can't be listed.
const managedDocs = (dir) => {
  const docs = present(join(dir, "managed-settings.json")) ? [join(dir, "managed-settings.json")] : [];
  const dropIns = join(dir, "managed-settings.d");
  if (present(dropIns)) for (const name of readdirSync(dropIns).toSorted()) if (name.endsWith(".json")) docs.push(join(dropIns, name));
  return docs;
};

// The machine as gatherFacts() reads it; tests pass their own.
const SYSTEM = {
  platform: process.platform,
  managedDir: MANAGED_DIRS[process.platform],
  mdmProfiles: () => (process.platform === "darwin" ? [join("/Library/Managed Preferences", MDM_DOMAIN), join("/Library/Managed Preferences", userInfo().username, MDM_DOMAIN)] : []),
  // WSL can take the Windows policy (registry or a file on the Windows side), which the hook can't read.
  wsl: () => process.platform === "linux" && /microsoft/i.test(readFileSync("/proc/version", "utf8")),
  ppid: process.ppid,
  processInfo,
};

// Why this hook call may not see every deny or ask rule Claude Code applies, or null; file checks only (ancestorBlindSpot walks the processes).
// Seen sources (read by gatherFacts): the user, project and project-local files and the managed settings files. Unseen ones: an MDM profile,
// a managed file that can't be read or that runs a policy helper (`policyHelper`, or `policyHelpers`: per-platform helpers and a default),
// server-managed settings (their cache file exists), WSL's Windows policy, and settings named by a RULE_ENV variable.
export const blindSpot = (env, configDir, system = SYSTEM) => {
  try {
    const variable = RULE_ENV.find((name) => (env[name] ?? "") !== "");
    if (variable) return `${variable} is set`;
    if (!system.managedDir) return `managed settings on ${system.platform} are not read`;
    if (system.wsl()) return "WSL can take the Windows policy";
    const profile = system.mdmProfiles().find(present);
    if (profile) return `MDM profile ${profile}`;
    for (const doc of managedDocs(system.managedDir)) {
      let json;
      try {
        json = readSettings(doc);
      } catch {
        return `${doc} could not be read`;
      }
      if (json === null) return `${doc} could not be read`;
      if ("policyHelper" in json || "policyHelpers" in json) return `${doc} names a policy helper`;
    }
    if (present(join(configDir, "remote-settings.json"))) return "server-managed settings";
    return null;
  } catch (error) {
    return `a settings source could not be read (${error.code ?? error.name})`;
  }
};

// Why the processes above the hook may hold rules it cannot read (RULE_FLAGS on one, or a walk that could not finish), or null; never throws.
// Run only for a line that would otherwise be rewritten: on macOS it costs one `ps` per ancestor (about 1.3 ms each on an Apple silicon Mac),
// up to the claude host (usually the hook's parent or grandparent). One `ps -A` listing instead measured slower there: 11 ms without args,
// 26 ms with them (843 processes), so the walk stays per process. `env`: the hook's (claude's); a BACKGROUND_ENV variable set walks to the top.
// `stop` (tests only): the walk ends before this pid.
export const ancestorBlindSpot = (system = SYSTEM, stop = 0, env = process.env) => {
  try {
    const atHost = !BACKGROUND_ENV.some((name) => (env[name] ?? "") !== "");
    return flaggedAncestor(system.ppid, stop, system.processInfo, { atHost });
  } catch (error) {
    return `the processes above the hook could not be read (${error.code ?? error.name})`;
  }
};

// The folders whose `.claude/settings.local.json` Claude Code may read: the project folder (older versions), the repo root (2.1.211 on), and
// for a worktree the main checkout's root. Reading one Claude Code skips only adds rules, and extra deny rules only skip a rewrite.
const localRoots = (project) => {
  const roots = [project];
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (present(git)) {
      roots.push(dir);
      const gitdir = statSync(git).isFile() ? /^gitdir: (.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim() : undefined;
      if (gitdir) {
        const own = resolve(dir, gitdir);
        let common = own;
        try {
          common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim());
        } catch {}
        roots.push(dirname(common));
      }
      return roots;
    }
    if (dirname(dir) === dir) return roots;
  }
};

// The I/O edge: what decide() needs from the machine for this hook call, the ancestor walk aside (hookMain runs it last). Any failure
// reading a rule source (a settings file that exists but can't be read or parsed included) is a blind spot (no rewrite).
// Project settings: `settings.json` from the project folder only (claude 2.1.285 started in a repo's subfolder reads the subfolder's, not the
// root's, and passes the subfolder as CLAUDE_PROJECT_DIR); `settings.local.json` also from the roots localRoots() names.
export const gatherFacts = (input, env, system = SYSTEM) => {
  const project = env.CLAUDE_PROJECT_DIR || input.cwd || ".";
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  let blind = blindSpot(env, configDir, system);
  let rules = { allow: [], deny: [], ask: [] };
  try {
    const locals = [...new Set(localRoots(project))].map((root) => join(root, ".claude", "settings.local.json"));
    rules = bashRules([join(configDir, "settings.json"), join(project, ".claude", "settings.json"), ...locals, ...(blind === null ? managedDocs(system.managedDir) : [])]);
  } catch (error) {
    blind ??= `a settings source could not be read (${error.code ?? error.name})`;
  }
  return {
    // Anything but a missing or false flag counts as backgrounded (a string "true" included): on doubt, no rewrite.
    background: !(input.tool_input?.run_in_background === undefined || input.tool_input?.run_in_background === false),
    versions: Object.fromEntries(Object.entries(REQUIRED).map(([bin, pkg]) => [bin, versionOnPath(bin, pkg, env)])),
    rules,
    blind,
  };
};

// The hook's stdout for a rewrite: every original tool_input field kept (run_in_background, timeout, description), the command replaced.
export const hookOutput = (input, command) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, command } } });

// `debabble hook claude [--list <file>]`: reads the layered wrap list (src/list.mjs) unless `--list` names one file; returns { code, stdout, stderr }. Always code 0; a usage error has one stderr line, and any failure is no output.
// Tests only: `system` stands in for the machine, and the ancestor walk stops before `stopPid` (the test runner's own ancestors may pass rule flags).
// `defaultList` stands in for the shipped default under the user file (tests only).
export const hookMain = (argv, { stdin, env = process.env, system = SYSTEM, stopPid = 0, defaultList } = {}) => {
  const [agent, ...rest] = argv;
  const listPath = rest[0] === "--list" && rest.length === 2 ? rest[1] : rest.length === 0 ? null : undefined;
  // Exit 0 even here: a hook that exits non-zero shows Claude Code an error on every Bash call; the line on stderr is enough.
  if (agent !== "claude" || listPath === undefined) return { code: 0, stdout: "", stderr: `debabble: ${USAGE}` };
  try {
    const input = JSON.parse(stdin());
    if (input?.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return { code: 0, stdout: "", stderr: "" };
    // No `--list`: the shipped default under the user file. A bad user file means no rewrite (the command runs unwrapped).
    const list = listPath === null ? readLayered(env, defaultList).list : readJson(resolve(listPath));
    if (!list || !Array.isArray(list.wrap)) return { code: 0, stdout: "", stderr: "" };
    let command = decide(input.tool_input.command, list, env, gatherFacts(input, env, system));
    // The walk last: a line that is not rewritten anyway starts no `ps`.
    if (command !== null && ancestorBlindSpot(system, stopPid, env) !== null) command = null;
    return { code: 0, stdout: command === null ? "" : hookOutput(input, command), stderr: "" };
  } catch {
    return { code: 0, stdout: "", stderr: "" };
  }
};
