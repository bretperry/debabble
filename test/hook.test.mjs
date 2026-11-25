// Tests for `debabble hook claude`: a table of command lines (rewrite or not), the gates (pins, mirror, background, opt-out), stdin edge cases, and byte-equality properties.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/hook.mjs; bin/debabble.mjs for the end-to-end cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ancestorBlindSpot, blindSpot, claudeHost, compareVersions, decide, flaggedAncestor, gatherFacts, hookMain, hookOutput, matchRule, processInfo, readLine } from "../src/hook.mjs";
import { BIN, tmp } from "./helpers.mjs";

const LIST = {
  requires: { debabble: "0.1.0" },
  wrap: [
    { match: "pnpm test", show: "verdict" },
    { match: "node --test", show: "verdict" },
    { match: "git fetch", show: "verdict" },
    { match: "gh run view", show: "excerpt" },
    { match: "ssh", show: "excerpt" },
  ],
};
// Everything met: versions at their pins, mirrors for every list entry, no deny, every rule source read.
const OK = {
  background: false,
  blind: null,
  versions: { debabble: "0.1.0" },
  rules: { allow: ["debabble -- pnpm test:*", "debabble -- node --test *", "debabble -- git fetch:*", "debabble --show excerpt -- gh run view *", "debabble --show excerpt -- ssh *"], deny: [], ask: [] },
};
const ENV = {};
const wrapped = (line, show = "verdict") => `debabble ${show === "excerpt" ? "--show excerpt " : ""}-- ${line}`;

// [line, expected rewrite or null, why]
const TABLE = [
  // rewritten
  ["pnpm test", wrapped("pnpm test"), "bare list entry"],
  ["pnpm test --run src/a.test.ts", wrapped("pnpm test --run src/a.test.ts"), "entry with arguments"],
  ["node --test test/hook.test.mjs", wrapped("node --test test/hook.test.mjs"), "node --test"],
  ["git fetch -q origin dev", wrapped("git fetch -q origin dev"), "git fetch with flags"],
  ["gh run view 123 --log-failed", wrapped("gh run view 123 --log-failed", "excerpt"), "excerpt mode entry"],
  ["ssh buildhost 'cd x && pnpm check'", wrapped("ssh buildhost 'cd x && pnpm check'", "excerpt"), "quoted && inside an argument is still simple"],
  ['ssh host "tail -n 50 a.log | grep x"', wrapped('ssh host "tail -n 50 a.log | grep x"', "excerpt"), "quoted pipe in double quotes"],
  ["pnpm test 'a;b'", wrapped("pnpm test 'a;b'"), "quoted semicolon"],
  ["pnpm test a\\;b", wrapped("pnpm test a\\;b"), "escaped semicolon"],
  ["pnpm test 'x > y'", wrapped("pnpm test 'x > y'"), "quoted redirection character"],
  ["pnpm  test   --run", null, "extra spaces: the mirror rule does not match those bytes"],
  ["pnpm\ttest", null, "tab between words: the mirror rule does not match"],
  ["pnpm test ", wrapped("pnpm test "), "trailing space kept"],
  ["pnpm test $HOME/x", wrapped("pnpm test $HOME/x"), "plain variable expands the same either way"],
  ["pnpm test --grep 'a b' \"c d\"", wrapped("pnpm test --grep 'a b' \"c d\""), "mixed quoting"],
  ["'pnpm' test", null, "quoted program name: on the list, but no mirror matches those bytes"],
  ["pnpm test a=b", wrapped("pnpm test a=b"), "assignment-looking argument after the program"],
  ["pnpm test héllo", wrapped("pnpm test héllo"), "non-ASCII argument"],
  // compound and shell syntax: untouched
  ["pnpm test && pnpm lint", null, "&&"],
  ["pnpm test || true", null, "||"],
  ["pnpm test; echo done", null, ";"],
  ["pnpm test | tail -5", null, "pipe"],
  ["pnpm test &", null, "backgrounded with &"],
  ["pnpm test > out.log", null, "redirect out"],
  ["pnpm test 2>&1", null, "redirect stderr"],
  ["pnpm test >> out.log", null, "append"],
  ["pnpm test < in.txt", null, "redirect in"],
  ["pnpm test <<EOF\nx\nEOF", null, "heredoc"],
  ["(pnpm test)", null, "subshell"],
  ["{ pnpm test; }", null, "group"],
  ["pnpm test $(cat args)", null, "command substitution"],
  ["pnpm test \"$(cat args)\"", null, "command substitution in double quotes"],
  ["pnpm test `cat args`", null, "backticks"],
  ["pnpm test \"`cat args`\"", null, "backticks in double quotes"],
  ["pnpm test\npnpm lint", null, "two lines"],
  ["pnpm test \\\n--run", null, "line continuation"],
  ["pnpm test # note", null, "comment"],
  ["pnpm test <(ls)", null, "process substitution"],
  ["pnpm test 'unclosed", null, "unterminated single quote"],
  ["pnpm test \"unclosed", null, "unterminated double quote"],
  ["pnpm test \\", null, "trailing backslash"],
  ["cd sub && pnpm test", null, "cd then entry"],
  // leading assignments: debabble would exec `FOO=bar`
  ["FOO=bar pnpm test", null, "leading assignment"],
  ["CI=1 node --test", null, "leading assignment before node"],
  ["A=1 B=2 pnpm test", null, "two assignments"],
  ['FOO="a b" pnpm test', null, "quoted assignment value"],
  // not on the list, or not a word prefix
  ["pnpm testx", null, "not a word prefix"],
  ["pnpm lint", null, "not on the list"],
  ["git diff", null, "reviewer read, not on the list"],
  ["node --testx", null, "not a word prefix of node --test"],
  ["node test.mjs --test", null, "words out of order"],
  ["sshd", null, "sshd is not ssh"],
  ["", null, "empty line"],
  ["   ", null, "only spaces"],
  // already wrapped
  ["debabble -- pnpm test", null, "already wrapped"],
  ["debabble --show excerpt -- ssh host x", null, "already wrapped with flags"],
  ["/usr/local/bin/debabble -- pnpm test", null, "already wrapped by path"],
  // line and paragraph separators
  ["pnpm test\u2028pnpm lint", null, "U+2028 line separator"],
  ["pnpm test\u2029x", null, "U+2029 paragraph separator"],
  ["pnpm test\u0085x", null, "U+0085 next line"],
  ["pnpm test \u0007", null, "control character"],
];

describe("table", () => {
  for (const [line, expected, why] of TABLE) {
    it(`${why}: ${JSON.stringify(line)}`, () => assert.equal(decide(line, LIST, ENV, OK), expected));
  }
  it("has about 60 lines", () => assert.ok(TABLE.length >= 55, String(TABLE.length)));
});

describe("gates", () => {
  const line = "pnpm test";
  const without = (patch) => decide(line, LIST, ENV, { ...OK, ...patch });
  it("DEBABBLE=off: no rewrite", () => assert.equal(decide(line, LIST, { DEBABBLE: "off" }, OK), null));
  it("run_in_background: no rewrite", () => assert.equal(without({ background: true }), null));
  it("run_in_background as the string \"true\" (or anything but false): no rewrite", () => {
    for (const background of ["true", 1, "yes", undefined]) assert.equal(without({ background }), null, String(background));
  });
  it("a deny on the original line: no rewrite, even with a broad mirror", () => {
    const rules = { allow: ["debabble:*", "debabble --show excerpt -- ssh *"], deny: ["ssh prod:*"], ask: [] };
    assert.equal(decide("ssh prod uptime", LIST, ENV, { ...OK, rules }), null);
    assert.equal(decide("ssh staging uptime", LIST, ENV, { ...OK, rules }), wrapped("ssh staging uptime", "excerpt"));
  });
  it("an ask on the original line: no rewrite", () => assert.equal(without({ rules: { ...OK.rules, ask: ["pnpm test"] } }), null));
  it("a deny on the original catches respellings (spaces, quotes, tabs)", () => {
    const rules = { allow: ["debabble:*"], deny: ["ssh prod:*", "git fetch:*"], ask: [] };
    for (const line of ["ssh  prod uptime", "ssh 'prod' uptime", "ssh\tprod uptime", "git  fetch --all", 'git "fetch" --all']) {
      assert.equal(decide(line, LIST, ENV, { ...OK, rules }), null, JSON.stringify(line));
    }
    assert.equal(decide("ssh  staging uptime", LIST, ENV, { ...OK, rules }), wrapped("ssh  staging uptime", "excerpt"));
  });
  it("a deny written as a glob on the original line: no rewrite", () => assert.equal(without({ rules: { ...OK.rules, deny: ["pnpm *"] } }), null));
  it("builtins and keywords are never wrapped, even when listed and mirrored", () => {
    const words = ["cd /tmp", "time git status", "export A=1", "source x.sh", ". x.sh", "exec pnpm test", "eval x", "command ls", "builtin cd", "if true", "alias a=b"];
    const list = { requires: LIST.requires, wrap: words.map((line) => ({ match: line.split(" ")[0], show: "verdict" })) };
    const facts = { ...OK, rules: { allow: ["debabble:*"], deny: [], ask: [] } };
    for (const line of words) assert.equal(decide(line, list, ENV, facts), null, line);
    assert.equal(decide("'cd' /tmp", list, ENV, facts), null, "quoted builtin");
  });
  it("no mirror allow rule: no rewrite", () => assert.equal(without({ rules: { allow: [], deny: [], ask: [] } }), null));
  it("a mirror for another entry does not count", () => assert.equal(without({ rules: { allow: ["debabble -- node --test *"], deny: [], ask: [] } }), null));
  it("an allow for the original line is not a mirror", () => assert.equal(without({ rules: { allow: ["pnpm test:*"], deny: [], ask: [] } }), null));
  it("exact mirror", () => assert.equal(without({ rules: { allow: ["debabble -- pnpm test"], deny: [], ask: [] } }), wrapped(line)));
  it("a deny rule on the rewritten line: no rewrite", () => assert.equal(without({ rules: { ...OK.rules, deny: ["debabble -- pnpm test"] } }), null));
  it("an ask rule on the rewritten line: no rewrite", () => assert.equal(without({ rules: { ...OK.rules, ask: ["debabble:*"] } }), null));
  it("debabble missing: no rewrite", () => assert.equal(without({ versions: {} }), null));
  it("debabble older than its pin: no rewrite", () => assert.equal(without({ versions: { debabble: "0.1.0-pre.1" } }), null));
  it("past its pin: rewrite", () => assert.equal(without({ versions: { debabble: "0.1.1" } }), wrapped(line)));
  it("the pin missing from the list: no rewrite", () => assert.equal(decide(line, { ...LIST, requires: {} }, ENV, OK), null));
  it("a pin for any other program is ignored", () => assert.equal(decide(line, { ...LIST, requires: { debabble: "0.1.0", other: "9.9.9" } }, ENV, OK), wrapped(line)));
  it("no requires at all (the default list): no rewrite", () => assert.equal(decide(line, { wrap: LIST.wrap }, ENV, OK), null));
  it("a version that is not one: no rewrite", () => assert.equal(without({ versions: { debabble: "latest" } }), null));
  it("a rule source the hook cannot read (or no word on it): no rewrite", () => {
    assert.equal(without({ blind: "MDM profile" }), null);
    assert.equal(without({ blind: undefined }), null);
  });
  it("the shipped default list rewrites nothing, even with every other gate met (its `requires` is empty on purpose)", () => {
    const list = JSON.parse(readFileSync(new URL("../src/default-wrap.json", import.meta.url), "utf8"));
    assert.deepEqual(list.requires, {});
    const facts = { ...OK, versions: { debabble: "99.0.0" }, rules: { allow: ["debabble:*"], deny: [], ask: [] } };
    for (const { match } of list.wrap) {
      assert.equal(decide(`${match} x`, { ...list, requires: { debabble: "0.0.1" } }, ENV, facts), wrapped(`${match} x`, match === "ssh" ? "excerpt" : "verdict"), match);
      assert.equal(decide(`${match} x`, list, ENV, facts), null, match);
    }
  });
});

// A machine: a debabble bin on a PATH folder with its package.json beside it, a HOME with user settings, a project with its own settings.
// shim: { bin: "0.2.0" } makes that bin a script that prints the version with no package.json (as a pnpm, Volta or asdf shim); "hang" makes it never answer.
const machine = ({ debabble = "0.1.0", allow = OK.rules.allow, projectAllow = [], deny = [], shim = {} } = {}) => {
  const root = tmp("hook");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, version] of Object.entries(shim)) {
    writeFileSync(join(bin, name), version === "hang" ? "#!/bin/sh\nsleep 5\n" : `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  for (const [name, pkg, version] of [["debabble", "debabble", debabble]]) {
    if (version === null || shim[name] !== undefined) continue;
    const dir = join(root, "lib", pkg);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
    writeFileSync(join(dir, "bin", `${name}.mjs`), "#!/usr/bin/env node\n");
    chmodSync(join(dir, "bin", `${name}.mjs`), 0o755);
    spawnSync("ln", ["-s", join(dir, "bin", `${name}.mjs`), join(bin, name)]);
  }
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: allow.map((r) => `Bash(${r})`), deny: deny.map((r) => `Bash(${r})`) } }));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [...projectAllow.map((r) => `Bash(${r})`), "Read(**)"] } }));
  const list = join(root, "wrap.json");
  writeFileSync(list, JSON.stringify(LIST));
  return { list, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_PROJECT_DIR: project, HOOK_HARNESS_STOP_PID: String(process.pid) } };
};
const stdin = (command, extra = {}) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/elsewhere", tool_input: { command, description: "run tests", timeout: 600000, ...extra } });

// A machine with nothing managed: the managed folder absent, no MDM profile, not WSL, and processes 10 → 1 with plain argv.
const fakeSystem = (root, extra = {}) => ({
  platform: "test",
  managedDir: join(root, "managed"),
  mdmProfiles: () => [join(root, "mdm.plist")],
  wsl: () => false,
  ppid: 10,
  processInfo: (pid) => ({ ppid: pid - 1, args: `/bin/proc${pid} --model x --verbose` }),
  ...extra,
});

describe("rule sources the hook reads, and the ones it cannot", () => {
  const settings = (path, permissions) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ permissions }));
  };

  it("ancestors: a rule flag in any spelling, on any process up to pid 1, is a blind spot", () => {
    const table = (args) => (pid) => ({ ppid: pid - 1, args: pid === 3 ? args : "/bin/sh -c x" });
    for (const args of ["claude --settings /tmp/s.json", "claude --settings={}", "claude -p --disallowedTools Bash(git push:*)", "claude --disallowed-tools=x", "claude --allowedTools x", "claude --allowed-tools x", "claude --input-format stream-json", "claude --permission-prompt-tool=stdio"]) {
      assert.match(flaggedAncestor(6, 0, table(args)) ?? "", /rule flag/, args);
    }
    for (const args of ["claude --model x", "claude --settingsx", "git --settings-file x", "claude"]) assert.equal(flaggedAncestor(6, 0, table(args)), null, args);
  });
  it("ancestors: hidden and other settings, agent, plugin, judge and background flags are blind spots too", () => {
    const table = (args) => (pid) => ({ ppid: pid - 1, args: pid === 3 ? args : "/bin/sh -c x" });
    const flagged = [
      `claude -p --managed-settings {"permissions":{"deny":["Bash(echo hi:*)"]}}`, `claude --managed-settings={"permissions":{}}`,
      "claude --client-data-url https://x", "claude --project-config-root /repo", "claude --tools Bash", "claude --agents {}", "claude --agent reviewer",
      "claude --plugin-dir /p", "claude --plugin-dir-no-mcp /p", "claude --plugin-url=https://x", "claude -p --permission-prompts host",
      "claude --bg", "claude --background", "claude --daemon-worker session", "claude --bg-spare", "claude --bg-pty-host x",
    ];
    for (const args of flagged) assert.match(flaggedAncestor(6, 0, table(args)) ?? "", /rule flag/, args);
    const plain = ["claude --setting-sources user", "claude --permission-mode auto", "claude --add-dir /x", "claude --restricted", "claude --agentx", "claude --bgx", "x --managed-settingsx"];
    for (const args of plain) assert.equal(flaggedAncestor(6, 0, table(args)), null, args);
  });
  it("a variable that points Claude Code at other settings is a blind spot", () => {
    for (const name of ["CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH", "CLAUDE_CODE_MOCK_REMOTE_SETTINGS", "CLAUDE_CODE_CLIENT_DATA_URL", "CLAUDE_CODE_BRIDGE_CHILD_MACHINE_SETTINGS", "CLAUDE_CODE_PLUGIN_DIRS"]) {
      assert.match(blindSpot({ [name]: "/x" }, tmp("cfg"), fakeSystem(tmp("sys"))) ?? "", new RegExp(`${name} is set`), name);
      assert.equal(blindSpot({ [name]: "" }, tmp("cfg"), fakeSystem(tmp("sys"))), null, `${name} empty`);
    }
  });
  it("ancestors: pid 1 is read too; the walk stops before `stop`", () => {
    assert.match(flaggedAncestor(3, 0, (pid) => ({ ppid: pid - 1, args: pid === 1 ? "claude --settings x" : "sh" })) ?? "", /rule flag/);
    assert.equal(flaggedAncestor(3, 1, (pid) => ({ ppid: pid - 1, args: pid === 1 ? "claude --settings x" : "sh" })), null);
  });
  it("ancestors: a process that can't be read, a loop, or a walk too long is a blind spot", () => {
    assert.match(flaggedAncestor(5, 0, (pid) => (pid === 3 ? null : { ppid: pid - 1, args: "sh" })) ?? "", /could not be read/);
    assert.match(flaggedAncestor(5, 0, () => ({ ppid: 5, args: "sh" })) ?? "", /could not be walked/);
    assert.match(flaggedAncestor(500, 0, (pid) => ({ ppid: pid - 1, args: "sh" })) ?? "", /could not be walked/);
  });
  it("this process's real ancestors can be read (ps, or /proc on Linux)", () => {
    // Under a host that passes rule flags (an agent session) the walk finds one; either way every process was read.
    assert.doesNotMatch(flaggedAncestor(process.pid, 0, processInfo) ?? "", /could not/);
    assert.match(processInfo(process.pid)?.args ?? "", /node|test/);
  });
  it("a walk that throws is a blind spot, never a crash", () => {
    assert.match(ancestorBlindSpot(fakeSystem(tmp("sys"), { processInfo: undefined })), /could not be read/);
  });
  it("nothing managed and plain ancestors: no blind spot", () => {
    assert.equal(blindSpot({}, tmp("cfg"), fakeSystem(tmp("sys"))), null);
    assert.equal(ancestorBlindSpot(fakeSystem(tmp("sys"))), null);
  });
  it("each unseen source is a blind spot", () => {
    const cases = {
      "no managed folder for the platform": (root) => fakeSystem(root, { managedDir: undefined }),
      WSL: (root) => fakeSystem(root, { wsl: () => true }),
      "an MDM profile": (root) => (writeFileSync(join(root, "mdm.plist"), ""), fakeSystem(root)),
      "a managed file that is not JSON": (root) => (mkdirSync(join(root, "managed")), writeFileSync(join(root, "managed", "managed-settings.json"), "{"), fakeSystem(root)),
      "a drop-in that is not JSON": (root) => (mkdirSync(join(root, "managed", "managed-settings.d"), { recursive: true }), writeFileSync(join(root, "managed", "managed-settings.d", "10-a.json"), "[]"), fakeSystem(root)),
      "a policyHelper": (root) => (mkdirSync(join(root, "managed")), writeFileSync(join(root, "managed", "managed-settings.json"), '{"policyHelper":"/x"}'), fakeSystem(root)),
    };
    for (const [why, build] of Object.entries(cases)) {
      const root = tmp("sys");
      assert.notEqual(blindSpot({}, join(root, "cfg"), build(root)), null, why);
    }
    const cfg = tmp("cfg");
    writeFileSync(join(cfg, "remote-settings.json"), "{}");
    assert.match(blindSpot({}, cfg, fakeSystem(tmp("sys"))), /server-managed/);
    assert.match(ancestorBlindSpot(fakeSystem(tmp("sys"), { processInfo: (pid) => ({ ppid: pid - 1, args: pid === 4 ? "claude --settings s.json" : "sh" }) })) ?? "", /rule flag/);
  });
  it("a managed file or drop-in with the plural `policyHelpers` (per-platform helpers and a default) is a blind spot", () => {
    for (const [name, json] of [["managed-settings.json", { policyHelpers: { darwin: { path: "/x" }, default: {} } }], ["managed-settings.d/10-a.json", { policyHelpers: {} }]]) {
      const root = tmp("sys");
      mkdirSync(join(root, "managed", "managed-settings.d"), { recursive: true });
      writeFileSync(join(root, "managed", name), JSON.stringify(json));
      assert.match(blindSpot({}, tmp("cfg"), fakeSystem(root)) ?? "", /policy helper/, name);
    }
  });
  it("the stop pid is a hookMain option only: DEBABBLE_HOOK_ROOT_PID in the env no longer ends the walk", () => {
    const system = fakeSystem(tmp("sys"), { processInfo: (pid) => ({ ppid: pid - 1, args: pid === 4 ? "claude --settings s.json" : "sh" }) });
    assert.equal(ancestorBlindSpot(system, 5), null);
    assert.notEqual(ancestorBlindSpot(system, 3), null);
    const m = machine();
    const run = (env, stopPid) => hookMain(["claude", "--list", m.list], { stdin: () => stdin("pnpm test"), env: { ...m.env, ...env }, system: { ...fakeSystem(tmp("sys")), processInfo: system.processInfo }, stopPid }).stdout;
    assert.equal(run({ DEBABBLE_HOOK_ROOT_PID: "5" }), "");
    assert.equal(run({}, 5), hookOutput(JSON.parse(stdin("pnpm test")), "debabble -- pnpm test"));
  });
  it("the ancestor walk runs only for a line that would be rewritten", () => {
    const m = machine();
    let reads = 0;
    const system = fakeSystem(tmp("sys"), { processInfo: (pid) => ((reads += 1), { ppid: pid - 1, args: "sh" }) });
    const run = (command) => hookMain(["claude", "--list", m.list], { stdin: () => stdin(command), env: m.env, system }).stdout;
    for (const command of ["pnpm lint", "git status", "pnpm test && x", "debabble -- pnpm test"]) assert.equal(run(command), "", command);
    assert.equal(reads, 0, "no process read for a line that is not rewritten");
    assert.notEqual(run("pnpm test"), "");
    assert.equal(reads, 10, "pids 10 → 1 read for the rewrite");
    const flagged = fakeSystem(tmp("sys"), { processInfo: (pid) => ({ ppid: pid - 1, args: pid === 2 ? "claude --managed-settings {}" : "sh" }) });
    assert.equal(hookMain(["claude", "--list", m.list], { stdin: () => stdin("pnpm test"), env: m.env, system: flagged }).stdout, "");
  });

  // The `claude` host: argv shapes as `ps -o args=` showed them (claude 2.1.285 from a terminal, the desktop app's 2.1.326), and look-alikes.
  const DESKTOP = "/Users/u/Library/Application Support/Claude/claude-code/2.1.326/abc123/claude.app/Contents/MacOS/claude";
  const HOSTS = [
    "/opt/homebrew/bin/claude -p --model haiku Run this",
    "claude",
    "claude --resume",
    `${DESKTOP} --output-format stream-json --verbose --effort=medium`,
    "/Applications/Claude.app/Contents/Resources/claude.app/Contents/MacOS/claude --model x",
    "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --model x",
    "/usr/bin/bun /opt/n/node_modules/@anthropic-ai/claude-code/bin/claude",
  ];
  const LOOKALIKES = [
    `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP} --model x`,
    "/bin/sh -c debabble hook claude --list /x/claude",
    "/bin/sh /tmp/claude",
    "/bin/sh /tmp/claude --x",
    "node /usr/local/bin/claude",
    "node -r /x/node_modules/@anthropic-ai/claude-code/cli.js main.js",
    "node /x/main.js /x/node_modules/@anthropic-ai/claude-code/cli.js",
    "claude-wrapper --x",
    "/opt/x/claude.sh",
    "/Applications/Claude.app/Contents/MacOS/Claude",
    "/Applications/Claude.app/Contents/Helpers/Claude iOS Sim.app/Contents/MacOS/claude-ios-sim",
    "/fake dir/claude --x",
  ];
  // A chain read top-down from pid `top`: args[0] is the hook's parent, the last one pid 1. Returns the walk's answer and the pids it read.
  const walk = (chain, stop = 0) => {
    const read = [];
    const top = chain.length;
    const info = (pid) => (read.push(pid), { ppid: pid - 1, args: chain[top - pid] });
    return { why: flaggedAncestor(top, stop, info), read };
  };
  it("claudeHost knows the claude host by its argv, and no look-alike", () => {
    for (const args of HOSTS) assert.equal(claudeHost(args), true, args);
    for (const args of LOOKALIKES) assert.equal(claudeHost(args), false, args);
  });
  it("ancestors: the walk stops at the nearest claude; a flag above it is not consulted, a flag on it is", () => {
    const above = ["/bin/sh -c debabble hook claude", "/opt/homebrew/bin/claude -p x", "/bin/zsh", "ide --settings s.json", "/sbin/launchd"];
    assert.deepEqual(walk(above), { why: null, read: [5, 4] });
    const on = ["/bin/sh -c debabble hook claude", "/opt/homebrew/bin/claude -p --settings s.json", "/bin/zsh", "/sbin/launchd"];
    assert.match(walk(on).why ?? "", /process 3 was started with a rule flag/);
    const below = ["/bin/sh --disallowedTools x", "claude", "/sbin/launchd"];
    assert.match(walk(below).why ?? "", /process 3 was started with a rule flag/);
  });
  it("ancestors: with no claude recognized, the walk goes to the top, and a look-alike never ends it", () => {
    for (const args of LOOKALIKES) {
      const { why, read } = walk(["/bin/sh -c x", args, "/bin/zsh", "/bin/zsh", "/bin/zsh", "/bin/zsh", "host --settings s.json"]);
      assert.match(why ?? "", /process 1 was started with a rule flag/, args);
      assert.deepEqual(read, [7, 6, 5, 4, 3, 2, 1], args);
    }
    assert.deepEqual(walk(["/bin/sh -c x", "/bin/zsh", "/sbin/launchd"]), { why: null, read: [3, 2, 1] });
  });
  it("ancestors: a claude inside a claude (`claude -p` from a session's Bash): the nearest one governs", () => {
    // As observed: the hook's shell, the inner terminal claude, the outer session's shell, the desktop claude with its host flags, disclaimer, the app.
    const nested = (inner) => ["/bin/sh -c debabble hook claude", inner, "/bin/zsh -c x", `${DESKTOP} --permission-prompt-tool=stdio --allowedTools=x`, `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP} --permission-prompt-tool=stdio`, "/Applications/Claude.app/Contents/MacOS/Claude", "/sbin/launchd"];
    assert.deepEqual(walk(nested("/opt/homebrew/bin/claude -p x")), { why: null, read: [7, 6] });
    assert.match(walk(nested("/opt/homebrew/bin/claude -p --agents {} x")).why ?? "", /process 6 was started with a rule flag/);
    // The outer claude alone (a Bash call of the desktop session): its flags govern, so no rewrite.
    assert.match(walk(nested("/bin/sh -c y").slice(1)).why ?? "", /process 4 was started with a rule flag/);
  });
  it("ancestors: in a background session (its env) the walk ignores the claude host and goes to the top", () => {
    // claude 2.1.285's pty host runs with argv0 `claude bg-pty-host` above the session's claude; the session's own argv may carry no flag.
    const chain = ["/bin/sh -c x", "/opt/homebrew/bin/claude", "claude bg-pty-host --bg-pty-host /s 200 50 -- /opt/homebrew/bin/claude", "/sbin/launchd"];
    const system = fakeSystem(tmp("sys"), { ppid: 4, processInfo: (pid) => ({ ppid: pid - 1, args: chain[4 - pid] }) });
    assert.equal(ancestorBlindSpot(system, 0, {}), null);
    for (const name of ["CLAUDE_JOB_DIR"]) {
      assert.match(ancestorBlindSpot(system, 0, { [name]: "bg" }) ?? "", /process 2 was started with a rule flag/, name);
      assert.equal(ancestorBlindSpot(system, 0, { [name]: "" }), null, `${name} empty`);
    }
    const m = machine();
    const run = (env) => hookMain(["claude", "--list", m.list], { stdin: () => stdin("pnpm test"), env: { ...m.env, ...env }, system }).stdout;
    assert.notEqual(run({}), "");
    assert.equal(run({ CLAUDE_JOB_DIR: "/jobs/x" }), "");
  });
  // Each level a user can write: the user file, the project file, the project-local file.
  const levels = (root) => {
    const config = join(root, "config");
    const project = join(root, "project");
    mkdirSync(join(config), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    return { env: { CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, PATH: "" }, files: { user: join(config, "settings.json"), project: join(project, ".claude", "settings.json"), local: join(project, ".claude", "settings.local.json") } };
  };
  it("a settings file starting with a UTF-8 BOM is read (Claude Code applies its rules), at every level", () => {
    for (const level of ["user", "project", "local"]) {
      const root = tmp("sys");
      const { env, files } = levels(root);
      writeFileSync(files[level], `\uFEFF${JSON.stringify({ permissions: { deny: ["Bash(echo hi:*)"] } })}`);
      const facts = gatherFacts({ tool_input: { command: "x" } }, env, fakeSystem(root));
      assert.equal(facts.blind, null, level);
      assert.deepEqual(facts.rules.deny, ["echo hi:*"], level);
    }
  });
  it("a settings file that exists but can't be parsed, isn't an object, or can't be read is a blind spot, at every level", () => {
    const bodies = { "not JSON": "{", comments: '// x\n{"permissions":{}}', "trailing comma": '{"permissions":{},}', "an array": "[]", "a string": '"x"' };
    for (const level of ["user", "project", "local"]) {
      for (const [why, body] of Object.entries(bodies)) {
        const root = tmp("sys");
        const { env, files } = levels(root);
        writeFileSync(files[level], body);
        assert.notEqual(gatherFacts({ tool_input: { command: "x" } }, env, fakeSystem(root)).blind, null, `${level}: ${why}`);
      }
      if (process.getuid?.() === 0) continue; // root reads a 000 file
      const root = tmp("sys");
      const { env, files } = levels(root);
      writeFileSync(files[level], "{}");
      chmodSync(files[level], 0o000);
      assert.match(gatherFacts({ tool_input: { command: "x" } }, env, fakeSystem(root)).blind ?? "", /EACCES/, `${level}: unreadable`);
      chmodSync(files[level], 0o600);
    }
  });
  it("project settings.json comes from the project folder only, not the repo root (claude 2.1.285, session started in a subfolder)", () => {
    const root = tmp("sys");
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub", ".claude"), { recursive: true });
    settings(join(repo, ".claude", "settings.json"), { allow: ["Bash(rootallow:*)"] });
    settings(join(repo, "sub", ".claude", "settings.json"), { allow: ["Bash(suballow:*)"] });
    const facts = gatherFacts({ tool_input: { command: "x" } }, { CLAUDE_CONFIG_DIR: join(root, "cfg"), CLAUDE_PROJECT_DIR: join(repo, "sub"), PATH: "" }, fakeSystem(root));
    assert.deepEqual(facts.rules.allow, ["suballow:*"]);
  });
  it("deny rules from managed files and drop-ins, CLAUDE_CONFIG_DIR, the repo root's and the main checkout's local file are read", () => {
    const root = tmp("sys");
    settings(join(root, "managed", "managed-settings.json"), { deny: ["Bash(managed:*)"] });
    settings(join(root, "managed", "managed-settings.d", "20-team.json"), { deny: ["Bash(dropin:*)"] });
    const config = join(root, "config");
    settings(join(config, "settings.json"), { allow: ["Bash(debabble:*)"], deny: ["Bash(configdir:*)"] });
    // A main checkout with a worktree; the session starts in a subfolder of the worktree.
    const main = join(root, "main");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    settings(join(main, ".claude", "settings.local.json"), { deny: ["Bash(mainlocal:*)"] });
    const wt = join(root, "wt");
    mkdirSync(join(wt, "sub"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    settings(join(wt, ".claude", "settings.local.json"), { deny: ["Bash(rootlocal:*)"] });
    const facts = gatherFacts({ cwd: "/nowhere", tool_input: { command: "x" } }, { CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: join(wt, "sub"), PATH: "" }, fakeSystem(root));
    assert.equal(facts.blind, null);
    assert.deepEqual(facts.rules.deny.toSorted(), ["configdir:*", "dropin:*", "mainlocal:*", "managed:*", "rootlocal:*"]);
  });
});

describe("versions and rules", () => {
  it("orders versions, prerelease before release", () => {
    const order = ["0.0.1", "0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.10", "0.1.0", "0.1.1", "0.2.0", "1.0.0"];
    for (let i = 0; i + 1 < order.length; i += 1) assert.ok(compareVersions(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.ok(Number.isNaN(compareVersions(undefined, "1.0.0")));
  });
  it("strict `:*` needs a word boundary; loose does not", () => {
    assert.equal(matchRule("debabble -- pnpm test:*", "debabble -- pnpm testx", "strict"), false);
    assert.equal(matchRule("debabble -- pnpm test:*", "debabble -- pnpm testx", "loose"), true);
    assert.equal(matchRule("debabble -- pnpm test:*", "debabble -- pnpm test", "strict"), true);
  });
  it("strict ` *` needs an argument; loose takes the bare command", () => {
    assert.equal(matchRule("debabble -- node --test *", "debabble -- node --test", "strict"), false);
    assert.equal(matchRule("debabble -- node --test *", "debabble -- node --test", "loose"), true);
  });
  it("regex characters in a rule are literal", () => assert.equal(matchRule("debabble -- a.b", "debabble -- axb", "strict"), false));
  it("reads words unquoted", () => assert.deepEqual(readLine(`a 'b c' "d \\"e\\"" f\\ g`), ["a", "b c", 'd "e"', "f g"]));
});

// A tiny seeded generator, so a failing case can be replayed.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
// The first four heads are listed and mirrored in LIST/OK; ssh is the excerpt one.
const HEADS = ["pnpm test", "node --test", "ssh", "git fetch", "FOO=1 pnpm test", "pnpm lint"];
const EXCERPT_HEADS = new Set(["ssh"]);
const ALPHABET = ["a", "b", "-", "-", " ", " ", "'", '"', "\\", ";", "&", "|", ">", "<", "(", ")", "$", "`", "#", "=", "*", "\n", "é", "{", "}", "\t", "!"];

describe("properties", () => {
  const rand = rng(20261122);
  const cases = [];
  for (let n = 0; n < 3000; n += 1) {
    let tail = "";
    const len = Math.floor(rand() * 14);
    for (let i = 0; i < len; i += 1) tail += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    const head = HEADS[Math.floor(rand() * HEADS.length)];
    cases.push({ head, line: head + (rand() < 0.7 ? " " : "") + tail });
  }
  // Lines that must be rewritten: a listed, mirrored head and plain words only.
  const plain = [];
  for (let n = 0; n < 500; n += 1) {
    let tail = "";
    const len = 1 + Math.floor(rand() * 10);
    for (let i = 0; i < len; i += 1) tail += "ab-x.9/é"[Math.floor(rand() * 8)];
    plain.push({ head: HEADS[Math.floor(rand() * 4)], line: "" });
    plain[n].line = `${plain[n].head} ${tail}`;
  }
  // The expected bytes, built from the generator's own head (not from decide): the prefix for that head's mode, then the line's UTF-8 bytes unchanged.
  const expectedBytes = ({ head, line }) => Buffer.concat([Buffer.from(`debabble ${EXCERPT_HEADS.has(head) ? "--show excerpt " : ""}-- `), Buffer.from(line, "utf8")]);

  it("when rewritten, the command is the head's prefix plus the exact original bytes", () => {
    let rewrites = 0;
    for (const item of cases) {
      const out = decide(item.line, LIST, ENV, OK);
      if (out === null) continue;
      rewrites += 1;
      assert.ok(Buffer.from(out, "utf8").equals(expectedBytes(item)), JSON.stringify(item.line));
    }
    assert.ok(rewrites > 100, `only ${rewrites} rewrites; the generator is not exercising the rewrite path`);
  });

  it("every plain line on a listed, mirrored head is rewritten to exactly those bytes", () => {
    for (const item of plain) {
      const out = decide(item.line, LIST, ENV, OK);
      assert.notEqual(out, null, JSON.stringify(item.line));
      assert.ok(Buffer.from(out, "utf8").equals(expectedBytes(item)), JSON.stringify(item.line));
    }
  });

  it("a line with an unquoted, unescaped shell operator is never rewritten", () => {
    for (const { line } of cases) {
      // Strip quoted spans and escapes as the shell would; whatever operator remains makes the line compound.
      const bare = line.replace(/\\[\s\S]/g, "").replace(/'[^']*'/g, "").replace(/"(?:[^"\\]|\\.)*"/g, "");
      if (/[;&|<>()`\n]/.test(bare)) assert.equal(decide(line, LIST, ENV, OK), null, JSON.stringify(line));
    }
  });

  it("a leading assignment is never rewritten", () => {
    for (const { line } of cases.filter((c) => c.line.startsWith("FOO="))) assert.equal(decide(line, LIST, ENV, OK), null, JSON.stringify(line));
  });
});

describe("hookMain", () => {
  const input = (command, extra = {}) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/nowhere", tool_input: { command, description: "run tests", timeout: 600000, ...extra } });
  const run = (argv, stdin, env = {}) => hookMain(argv, { stdin: () => stdin, env });

  it("malformed stdin: exit 0, no output", () => assert.deepEqual(run(["claude"], "{not json"), { code: 0, stdout: "", stderr: "" }));
  it("empty stdin: exit 0, no output", () => assert.deepEqual(run(["claude"], ""), { code: 0, stdout: "", stderr: "" }));
  it("stdin that throws: exit 0, no output", () => assert.deepEqual(hookMain(["claude"], { stdin: () => { throw new Error("EAGAIN"); }, env: {} }), { code: 0, stdout: "", stderr: "" }));
  it("a non-Bash tool: no output", () => assert.equal(run(["claude"], JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } })).stdout, ""));
  it("a missing command: no output", () => assert.equal(run(["claude"], JSON.stringify({ tool_name: "Bash", tool_input: {} })).stdout, ""));
  it("a list file that does not exist: no output", () => assert.equal(run(["claude", "--list", "/nowhere/list.json"], input("pnpm test")).stdout, ""));
  it("the default list rewrites nothing until a list sets its pins", () => assert.equal(run(["claude"], input("node --test")).stdout, ""));
  it("usage errors: exit 0 with one line on stderr", () => {
    for (const argv of [[], ["cursor"], ["claude", "--list"], ["claude", "--bogus"], ["claude", "--list", "a", "b"]]) {
      const out = run(argv, input("pnpm test"));
      assert.equal(out.code, 0, JSON.stringify(argv));
      assert.equal(out.stdout, "");
      assert.match(out.stderr, /^debabble: usage: debabble hook claude/);
    }
  });
});

describe("end to end (bin, fake PATH, settings files)", () => {
  // These runs read this machine's real managed settings; a machine that has some never rewrites, so the rewrite cases are skipped there.
  const hostBlind = blindSpot({}, tmp("cfg")) ?? false;
  // The bin's hook branch with the ancestor walk stopped before HOOK_HARNESS_STOP_PID (this test process): an agent session above the test
  // runner may pass rule flags, and production takes no stop pid. The bin itself: the usage, broken-install and --version cases below.
  const HARNESS = ["--input-type=module", "-e", `import { readFileSync } from "node:fs"; import { hookMain } from ${JSON.stringify(new URL("../src/hook.mjs", import.meta.url).href)}; const r = hookMain(process.argv.slice(2), { stdin: () => readFileSync(0, "utf8"), stopPid: Number(process.env.HOOK_HARNESS_STOP_PID) || 0 }); if (r.stdout) process.stdout.write(r.stdout + "\\n"); if (r.stderr) process.stderr.write(r.stderr + "\\n");`];
  const hook = ({ list, env }, stdin, argv = ["hook", "claude", "--list", list], via = HARNESS) =>
    spawnSync(process.execPath, [...via, ...argv], { input: stdin, env, encoding: "utf8" });

  it("rewrites, keeping every other tool_input field, with no permissionDecision", { skip: hostBlind }, () => {
    const out = hook(machine(), stdin("pnpm test --run a"));
    assert.equal(out.status, 0);
    assert.equal(out.stderr, "");
    const json = JSON.parse(out.stdout);
    assert.deepEqual(json, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "debabble -- pnpm test --run a", description: "run tests", timeout: 600000 } } });
  });
  it("a project-level mirror counts", { skip: hostBlind }, () => {
    const out = hook(machine({ allow: [], projectAllow: ["debabble -- pnpm test:*"] }), stdin("pnpm test"));
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.updatedInput.command, "debabble -- pnpm test");
  });
  it("a deny passed by `claude --settings` (a process above the hook): no output, though the same call rewrites without it", { skip: hostBlind }, () => {
    const m = machine();
    // A stand-in for `claude --settings deny.json`: a node process whose argv carries the flag, running the hook as its child.
    const viaParent = (args) => {
      const source = `const r = require("node:child_process").spawnSync(process.execPath, ${JSON.stringify([...HARNESS, "hook", "claude", "--list", m.list])}, { input: ${JSON.stringify(stdin("git fetch origin"))}, encoding: "utf8" }); process.stdout.write(r.stdout);`;
      return spawnSync(process.execPath, ["-e", source, "--", ...args], { env: m.env, encoding: "utf8" });
    };
    assert.equal(viaParent(["--settings", "/tmp/deny.json"]).stdout, "");
    assert.equal(viaParent(["--disallowedTools=Bash(git fetch:*)"]).stdout, "");
    assert.equal(JSON.parse(viaParent(["--model", "x"]).stdout).hookSpecificOutput.updatedInput.command, "debabble -- git fetch origin");
  });
  it("debabble behind a shim (no package.json): its --version answers, rewrite", { skip: hostBlind }, () => {
    const out = hook(machine({ shim: { debabble: "v0.1.1" } }), stdin("pnpm test"));
    assert.equal(JSON.parse(out.stdout).hookSpecificOutput.updatedInput.command, "debabble -- pnpm test");
  });
  it("a shim older than its pin: no output", () => assert.equal(hook(machine({ shim: { debabble: "0.0.9" } }), stdin("pnpm test")).stdout, ""));
  it("a shim that prints no version: no output", () => assert.equal(hook(machine({ shim: { debabble: "oops" } }), stdin("pnpm test")).stdout, ""));
  it("a shim that hangs: no output, within the version timeout", () => {
    const started = Date.now();
    const out = hook(machine({ shim: { debabble: "hang" } }), stdin("pnpm test"));
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
    assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
  });
  it("run_in_background as a string: no output", () => assert.equal(hook(machine(), stdin("pnpm test", { run_in_background: "true" })).stdout, ""));
  it("a usage error through the bin: exit 0, one stderr line", () => {
    const m = machine();
    const out = hook(m, stdin("pnpm test"), ["hook", "cursor"], [BIN]);
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^debabble: usage: debabble hook claude/);
  });
  it("a broken install (hook module fails to import): exit 0, no output", () => {
    const root = tmp("broken");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "bin", "debabble.mjs"), readFileSync(BIN, "utf8"));
    writeFileSync(join(root, "src", "hook.mjs"), "this is not javascript (\n");
    const out = spawnSync(process.execPath, [join(root, "bin", "debabble.mjs"), "hook", "claude"], { input: stdin("pnpm test"), encoding: "utf8" });
    assert.equal(out.status, 0);
    assert.equal(out.stdout + out.stderr, "");
  });
  it("run_in_background: no output", () => assert.equal(hook(machine(), stdin("pnpm test", { run_in_background: true })).stdout, ""));
  it("debabble not on PATH: no output", () => assert.equal(hook(machine({ debabble: null }), stdin("pnpm test")).stdout, ""));
  it("debabble older than its pin: no output", () => assert.equal(hook(machine({ debabble: "0.0.9" }), stdin("pnpm test")).stdout, ""));
  it("no mirror anywhere: no output", () => assert.equal(hook(machine({ allow: [] }), stdin("pnpm test")).stdout, ""));
  it("a user deny on the rewritten line: no output", () => assert.equal(hook(machine({ deny: ["debabble:*"] }), stdin("pnpm test")).stdout, ""));
  it("DEBABBLE=off in the hook's env: no output", () => {
    const m = machine();
    assert.equal(hook({ ...m, env: { ...m.env, DEBABBLE: "off" } }, stdin("pnpm test")).stdout, "");
  });
  it("malformed stdin: exit 0, no output", () => {
    const out = hook(machine(), "]]");
    assert.equal(out.status, 0);
    assert.equal(out.stdout + out.stderr, "");
  });
  it("the default list file parses and has the Phase 3 entries", () => {
    const list = JSON.parse(readFileSync(new URL("../src/default-wrap.json", import.meta.url), "utf8"));
    assert.deepEqual(list.wrap.map((e) => `${e.match} · ${e.show}`), ["git fetch · verdict", "node --test · verdict", "ssh · excerpt"]);
  });
  it("--version prints the package version", () => {
    const out = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});

describe("the layered wrap list (no --list)", () => {
  const writeUser = (wrap, raw) => {
    const xdg = tmp("xdg");
    mkdirSync(join(xdg, "debabble"));
    writeFileSync(join(xdg, "debabble", "wrap.json"), raw ?? JSON.stringify({ wrap }));
    return xdg;
  };
  const system = () => fakeSystem(tmp("sys"));
  // A stand-in for the shipped default with the pins set, so the layered list can rewrite.
  const run = (m, xdg, command) =>
    hookMain(["claude"], { stdin: () => stdin(command), env: { ...m.env, XDG_CONFIG_HOME: xdg }, system: system(), stopPid: process.pid, defaultList: LIST }).stdout;
  const m = machine({ allow: [...OK.rules.allow, "debabble -- pnpm check:*"] });

  it("an added `pnpm check` is rewritten", () => {
    const xdg = writeUser([{ match: "pnpm check", show: "verdict" }]);
    assert.equal(run(m, xdg, "pnpm check"), hookOutput(JSON.parse(stdin("pnpm check")), "debabble -- pnpm check"));
  });
  it("a disabled `git fetch` stops rewriting; the others still do", () => {
    const xdg = writeUser([{ match: "git fetch", show: "verdict", enabled: false }]);
    assert.equal(run(m, xdg, "git fetch origin"), "");
    assert.equal(run(m, xdg, "pnpm test"), hookOutput(JSON.parse(stdin("pnpm test")), "debabble -- pnpm test"));
  });
  it("no user file: the default alone", () => assert.equal(run(m, tmp("empty"), "git fetch origin"), hookOutput(JSON.parse(stdin("git fetch origin")), "debabble -- git fetch origin")));
  it("a malformed user file: no rewrite at all", () => assert.equal(run(m, writeUser(null, "{nope"), "git fetch origin"), ""));
  it("--list skips layering: a user disable does not apply to an explicit file", () => {
    const xdg = writeUser([{ match: "git fetch", show: "verdict", enabled: false }]);
    const out = hookMain(["claude", "--list", m.list], { stdin: () => stdin("git fetch origin"), env: { ...m.env, XDG_CONFIG_HOME: xdg }, system: system(), stopPid: process.pid }).stdout;
    assert.equal(out, hookOutput(JSON.parse(stdin("git fetch origin")), "debabble -- git fetch origin"));
  });
  it("`requires` stays the shipped default's: a user file cannot lower the pins", () => {
    const xdg = writeUser([]);
    const raw = JSON.stringify({ requires: {}, wrap: [{ match: "pnpm check", show: "verdict" }] });
    const xdg2 = writeUser(null, raw);
    const old = machine({ debabble: "0.0.9", allow: OK.rules.allow });
    assert.equal(run(old, xdg, "pnpm test"), "");
    assert.equal(run(old, xdg2, "pnpm test"), "");
  });
});
