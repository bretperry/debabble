// `debabble list`: show, add, disable and enable entries of the wrap list, so nobody hand-edits JSON; and the layered read the hook uses.
// In the app: bin/debabble.mjs runs `listMain` for `debabble list …`; src/hook.mjs calls `readLayered` when no `--list <file>` is given.
// Run: `debabble list show`, `debabble list add <match> --show verdict|excerpt`, `debabble list disable <match>`, `debabble list enable <match>`.
// Env: XDG_CONFIG_HOME (else $HOME/.config) holds `debabble/wrap.json`, the user file.
// Writes: the user file only, atomically (temp file in the same folder, then rename); file 0600, a folder it creates 0700. A malformed user file is reported and never touched.
// Exit: 0 done; 1 refused or not found or a bad user file; 125 usage error.
// Layering: the shipped default (src/default-wrap.json) with the user file over it by `match`: a user entry replaces the default entry with the same match, in place;
// user-only entries follow. `requires` always comes from the shipped default. There is no remove: `disable` writes `enabled: false`; absent means enabled.
// Exports: NOT_PROGRAMS, userListPath(env), layer(base, user), readLayered(env, base), refusal(match), listMain(argv, { env, base }).
// Uses: node builtins only. Imported by src/hook.mjs on every Bash call, so keep it small.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_LIST = new URL("./default-wrap.json", import.meta.url);
const USAGE = "usage: debabble list show | add <match> --show verdict|excerpt | disable <match> | enable <match>";

// Shell builtins, keywords and wrappers that change how or where the rest runs. debabble execs argv with no shell, so a line (or list entry) starting with one is never wrapped.
export const NOT_PROGRAMS = new Set([
  ".", ":", "[[", "]]", "!", "{", "}", "alias", "bg", "bind", "break", "builtin", "caller", "case", "cd", "command", "compgen", "complete", "continue", "coproc",
  "declare", "dirs", "disown", "do", "done", "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "fc", "fg", "fi", "for", "function", "getopts",
  "hash", "help", "history", "if", "in", "jobs", "let", "local", "logout", "mapfile", "popd", "pushd", "read", "readarray", "readonly", "return", "select", "set",
  "shift", "shopt", "source", "suspend", "then", "time", "times", "trap", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
]);

// `$XDG_CONFIG_HOME/debabble/wrap.json`, else `$HOME/.config/debabble/wrap.json` (an empty variable counts as unset).
export const userListPath = (env = process.env) => join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "debabble", "wrap.json");

// A match is compared as its words joined by one space.
const norm = (match) => match.trim().split(/\s+/).join(" ");

// The shipped entries with each replaced by the user entry of the same match, then the user-only entries. `requires` is the base's.
export const layer = (base, user) => {
  const mine = new Map();
  for (const e of user?.wrap ?? []) if (typeof e?.match === "string") mine.set(norm(e.match), e);
  const used = new Set();
  const wrap = (base?.wrap ?? []).map((e) => {
    const key = typeof e?.match === "string" ? norm(e.match) : null;
    if (key === null || !mine.has(key)) return e;
    used.add(key);
    return mine.get(key);
  });
  for (const [key, e] of mine) if (!used.has(key)) wrap.push(e);
  return { ...base, wrap };
};

const readBase = (base) => base ?? JSON.parse(readFileSync(DEFAULT_LIST, "utf8"));

// Reads the user file. { user: null } when it does not exist; { error } when it can't be read or isn't `{ "wrap": [...] }`.
const readUser = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? { user: null } : { error: `${path}: ${error.message}` };
  }
  try {
    const user = JSON.parse(text);
    if (user === null || typeof user !== "object" || Array.isArray(user) || !Array.isArray(user.wrap)) return { error: `${path}: not a wrap list (expected {"wrap": [...]})` };
    return { user };
  } catch (error) {
    return { error: `${path}: malformed JSON (${error.message}); left untouched` };
  }
};

// The list the hook reads: shipped default under the user file. { list } or { error } (a bad user file; the hook then rewrites nothing).
export const readLayered = (env = process.env, base) => {
  const { user, error } = readUser(userListPath(env));
  return error ? { error } : { list: layer(readBase(base), user) };
};

// A reason `match` can't be added, or null. The hook wraps simple commands only.
export const refusal = (match) => {
  const words = norm(match).split(" ");
  if (words[0] === "") return "match is empty";
  if (NOT_PROGRAMS.has(words[0])) return `"${words[0]}" is a shell builtin or keyword, not a program`;
  const op = /;|&|\||<|>|\$\(|`|\n|\r/.exec(match);
  return op ? `match contains a shell operator (${JSON.stringify(op[0])})` : null;
};

// Temp file in the same folder, then rename. The folder is made 0700 when new; the file is 0600.
const writeAtomic = (path, data) => {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.wrap.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

const out = (code, stdout = "", stderr = "") => ({ code, stdout, stderr });
const fail = (message) => out(1, "", `debabble: ${message}`);
const usage = () => out(125, "", `debabble: ${USAGE}`);
const pad = (text, width) => text.padEnd(width);

// `debabble list …`: returns { code, stdout, stderr }. `base` is for tests (a stand-in for the shipped default).
export const listMain = (argv, { env = process.env, base } = {}) => {
  const [sub, ...rest] = argv;
  const path = userListPath(env);
  const baseList = readBase(base);
  const { user, error } = readUser(path);
  if (!["show", "add", "disable", "enable"].includes(sub)) return usage();
  if (error) return fail(error);
  const userWrap = user?.wrap ?? [];
  const baseKeys = new Set((baseList.wrap ?? []).filter((e) => typeof e?.match === "string").map((e) => norm(e.match)));
  const userKeys = new Map(userWrap.filter((e) => typeof e?.match === "string").map((e) => [norm(e.match), e]));

  if (sub === "show") {
    if (rest.length) return usage();
    const merged = layer(baseList, user);
    const rows = merged.wrap
      .filter((e) => typeof e?.match === "string")
      .map((e) => [e.match, e.show === "excerpt" ? "excerpt" : "verdict", userKeys.has(norm(e.match)) ? "user" : "default", e.enabled === false ? "disabled" : "enabled"]);
    const width = Math.max(5, ...rows.map((r) => r[0].length));
    const lines = [[pad("match", width), "show   ", "source ", "state"].join("  "), ...rows.map((r) => [pad(r[0], width), pad(r[1], 7), pad(r[2], 7), r[3]].join("  "))];
    return out(0, lines.join("\n"));
  }

  let match;
  let showMode;
  if (sub === "add") {
    if (rest.length !== 3 || rest[1] !== "--show" || !["verdict", "excerpt"].includes(rest[2])) return usage();
    [match, , showMode] = rest;
    const reason = refusal(match);
    if (reason) return fail(`refused: ${reason}`);
  } else {
    if (rest.length !== 1) return usage();
    [match] = rest;
  }
  const key = norm(match);

  let next;
  let message;
  if (sub === "add") {
    if (baseKeys.has(key) || userKeys.has(key)) return fail(`"${key}" is already on the list (use enable or disable)`);
    next = [...userWrap, { match: key, show: showMode }];
    message = `added ${key} (${showMode})`;
  } else {
    const flag = sub === "enable";
    const own = userKeys.get(key);
    const shipped = (baseList.wrap ?? []).find((e) => typeof e?.match === "string" && norm(e.match) === key);
    if (!own && !shipped) return fail(`"${key}" is not on the list`);
    const entry = { ...(own ?? shipped), match: own ? own.match : shipped.match };
    if (flag) delete entry.enabled;
    else entry.enabled = false;
    // Enabling a default that has no user entry: nothing to write.
    if (!own && flag) return out(0, `${key} already enabled`);
    next = own ? userWrap.map((e) => (e === own ? entry : e)) : [...userWrap, entry];
    message = `${flag ? "enabled" : "disabled"} ${key}`;
  }
  try {
    writeAtomic(path, { ...user, wrap: next });
  } catch (error) {
    return fail(`could not write ${path}: ${error.message}`);
  }
  return out(0, message);
};
