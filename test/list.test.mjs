// Tests for `debabble list` and the layered read: show, add, disable, enable, layering by `match`, refused matches, atomic 0600/0700 writes, bad JSON left alone.
// In the app: nothing at runtime. Run: `node --test test/list.test.mjs`.
// Used by: `npm test`.
// Uses: src/list.mjs; bin/debabble.mjs for the end-to-end cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { layer, listMain, readLayered, refusal, userListPath } from "../src/list.mjs";
import { BIN, cleanEnv, tmp } from "./helpers.mjs";

const BASE = { requires: { debabble: "0.1.0" }, wrap: [{ match: "git fetch", show: "verdict" }, { match: "ssh", show: "excerpt" }] };
const setup = () => {
  const xdg = tmp("xdg");
  const file = join(xdg, "debabble", "wrap.json");
  const run = (...argv) => listMain(argv, { env: { XDG_CONFIG_HOME: xdg }, base: BASE });
  const user = () => JSON.parse(readFileSync(file, "utf8"));
  return { xdg, file, run, user };
};

describe("user file path", () => {
  it("XDG_CONFIG_HOME wins", () => assert.equal(userListPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), "/x/debabble/wrap.json"));
  it("else $HOME/.config", () => assert.equal(userListPath({ HOME: "/h" }), "/h/.config/debabble/wrap.json"));
  it("an empty XDG_CONFIG_HOME counts as unset", () => assert.equal(userListPath({ XDG_CONFIG_HOME: "", HOME: "/h" }), "/h/.config/debabble/wrap.json"));
});

describe("layering", () => {
  it("a user entry replaces the default entry with the same match, in place", () => {
    const merged = layer(BASE, { wrap: [{ match: "git fetch", show: "excerpt", enabled: false }] });
    assert.deepEqual(merged.wrap, [{ match: "git fetch", show: "excerpt", enabled: false }, { match: "ssh", show: "excerpt" }]);
  });
  it("user-only entries follow the defaults", () => {
    assert.deepEqual(layer(BASE, { wrap: [{ match: "pnpm check", show: "verdict" }] }).wrap.map((e) => e.match), ["git fetch", "ssh", "pnpm check"]);
  });
  it("matches compare with whitespace collapsed", () => assert.equal(layer(BASE, { wrap: [{ match: " git   fetch ", show: "excerpt" }] }).wrap.length, 2));
  it("requires comes from the default only", () => assert.deepEqual(layer(BASE, { requires: {}, wrap: [] }).requires, { debabble: "0.1.0" }));
  it("no user file: the default as is", () => assert.deepEqual(layer(BASE, null), BASE));
  it("readLayered: user file over the default; a bad one is an error", () => {
    const s = setup();
    s.run("add", "pnpm check", "--show", "verdict");
    assert.deepEqual(readLayered({ XDG_CONFIG_HOME: s.xdg }, BASE).list.wrap.map((e) => e.match), ["git fetch", "ssh", "pnpm check"]);
    writeFileSync(s.file, "{oops");
    assert.match(readLayered({ XDG_CONFIG_HOME: s.xdg }, BASE).error, /malformed JSON/);
    assert.equal(readLayered({ XDG_CONFIG_HOME: tmp("none") }, BASE).list.wrap.length, 2);
  });
});

describe("show", () => {
  it("lists every entry with its source and state", () => {
    const s = setup();
    s.run("add", "pnpm check", "--show", "verdict");
    s.run("disable", "ssh");
    const lines = s.run("show").stdout.split("\n").map((l) => l.split(/\s+/));
    assert.deepEqual(lines[1], ["git", "fetch", "verdict", "default", "enabled"]);
    assert.deepEqual(lines[2], ["ssh", "excerpt", "user", "disabled"]);
    assert.deepEqual(lines[3], ["pnpm", "check", "verdict", "user", "enabled"]);
  });
  it("with no user file it writes nothing", () => {
    const s = setup();
    assert.equal(s.run("show").code, 0);
    assert.equal(existsSync(s.file), false);
  });
});

describe("add", () => {
  it("writes a user entry, enabled by absence", () => {
    const s = setup();
    assert.equal(s.run("add", "pnpm  check", "--show", "excerpt").code, 0);
    assert.deepEqual(s.user(), { wrap: [{ match: "pnpm check", show: "excerpt" }] });
  });
  it("an existing match (default or user) is refused", () => {
    const s = setup();
    assert.equal(s.run("add", "git fetch", "--show", "excerpt").code, 1);
    s.run("add", "x", "--show", "verdict");
    assert.equal(s.run("add", "x", "--show", "verdict").code, 1);
  });
  it("usage errors exit 125", () => {
    const s = setup();
    for (const argv of [["add"], ["add", "x"], ["add", "x", "--show"], ["add", "x", "--show", "all"], ["add", "x", "--bogus", "verdict"], ["add", "x", "y", "--show", "verdict"], ["remove", "ssh"], [], ["show", "x"], ["disable"], ["disable", "a", "b"]]) {
      assert.equal(s.run(...argv).code, 125, JSON.stringify(argv));
    }
    assert.equal(existsSync(s.file), false);
  });
});

describe("refused matches", () => {
  const cases = [
    ["", "empty"], ["   ", "blank"], ["cd /tmp", "builtin"], ["export X=1", "builtin"], ["time ls", "builtin"], ["if true", "keyword"], ["for x", "keyword"],
    ["a; b", ";"], ["a && b", "&&"], ["a || b", "||"], ["a | b", "|"], ["a > f", ">"], ["a < f", "<"], ["a >> f", ">>"], ["a $(b)", "$("], ["a `b`", "backtick"], ["a & b", "&"], ["a\nb", "newline"],
  ];
  for (const [match, why] of cases) {
    it(`${why}: ${JSON.stringify(match)}`, () => {
      assert.ok(refusal(match), "refusal()");
      const s = setup();
      const r = s.run("add", match, "--show", "verdict");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /refused/);
      assert.equal(existsSync(s.file), false);
    });
  }
  it("a plain program is accepted", () => assert.equal(refusal("pnpm check"), null));
  it("a quoted word is accepted", () => assert.equal(refusal("git commit -m"), null));
});

describe("disable and enable", () => {
  it("disable on a default writes a user entry with enabled:false and the default's show", () => {
    const s = setup();
    assert.equal(s.run("disable", "ssh").code, 0);
    assert.deepEqual(s.user(), { wrap: [{ match: "ssh", show: "excerpt", enabled: false }] });
  });
  it("enable undoes it (absent means enabled)", () => {
    const s = setup();
    s.run("disable", "git fetch");
    assert.equal(s.run("enable", "git fetch").code, 0);
    assert.deepEqual(s.user(), { wrap: [{ match: "git fetch", show: "verdict" }] });
    assert.match(s.run("show").stdout, /git fetch\s+verdict\s+user\s+enabled/);
  });
  it("disable then enable on a user-added entry keeps its place", () => {
    const s = setup();
    s.run("add", "a", "--show", "verdict");
    s.run("add", "b", "--show", "verdict");
    s.run("disable", "a");
    assert.deepEqual(s.user().wrap.map((e) => [e.match, e.enabled]), [["a", false], ["b", undefined]]);
  });
  it("enable on a default with no user entry writes nothing", () => {
    const s = setup();
    assert.equal(s.run("enable", "ssh").code, 0);
    assert.equal(existsSync(s.file), false);
  });
  it("an unknown match: exit 1, nothing written; there is no remove", () => {
    const s = setup();
    assert.equal(s.run("disable", "nope").code, 1);
    assert.equal(s.run("enable", "nope").code, 1);
    assert.equal(s.run("remove", "ssh").code, 125);
    assert.equal(existsSync(s.file), false);
  });
  it("a default is never removed from the merged view", () => {
    const s = setup();
    s.run("disable", "ssh");
    assert.equal(readLayered({ XDG_CONFIG_HOME: s.xdg }, BASE).list.wrap.length, 2);
  });
});

describe("writes", () => {
  it("file 0600 in a 0700 dir it creates, and no temp file is left", () => {
    const s = setup();
    s.run("add", "x", "--show", "verdict");
    assert.equal(statSync(s.file).mode & 0o777, 0o600);
    assert.equal(statSync(join(s.xdg, "debabble")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(s.xdg, "debabble")), ["wrap.json"]);
  });
  it("a rewrite keeps the file 0600", () => {
    const s = setup();
    s.run("add", "x", "--show", "verdict");
    s.run("add", "y", "--show", "verdict");
    assert.equal(statSync(s.file).mode & 0o777, 0o600);
  });
  it("a failed write leaves the old file intact and no temp file", () => {
    const s = setup();
    s.run("add", "x", "--show", "verdict");
    const before = readFileSync(s.file, "utf8");
    // The folder turns read-only: the temp file can't be made, so the rename never happens.
    spawnSync("chmod", ["500", join(s.xdg, "debabble")]);
    const r = s.run("add", "y", "--show", "verdict");
    spawnSync("chmod", ["700", join(s.xdg, "debabble")]);
    if (process.getuid?.() !== 0) assert.equal(r.code, 1);
    assert.equal(readFileSync(s.file, "utf8"), before);
    assert.deepEqual(readdirSync(join(s.xdg, "debabble")), ["wrap.json"]);
  });
  it("other keys in the user file survive a write", () => {
    const s = setup();
    mkdirSync(join(s.xdg, "debabble"));
    writeFileSync(s.file, JSON.stringify({ note: "mine", wrap: [] }));
    s.run("add", "x", "--show", "verdict");
    assert.equal(s.user().note, "mine");
  });
});

describe("malformed user file", () => {
  const bad = ["{nope", "", "[]", "null", '{"wrap": 3}', '{"nowrap": []}'];
  for (const text of bad) {
    it(`${JSON.stringify(text)}: reported with the path, left byte for byte`, () => {
      const s = setup();
      mkdirSync(join(s.xdg, "debabble"));
      writeFileSync(s.file, text);
      for (const argv of [["show"], ["add", "x", "--show", "verdict"], ["disable", "ssh"], ["enable", "ssh"]]) {
        const r = s.run(...argv);
        assert.equal(r.code, 1, JSON.stringify(argv));
        assert.ok(r.stderr.includes(s.file), r.stderr);
        assert.equal(readFileSync(s.file, "utf8"), text);
      }
    });
  }
});

describe("through the bin", () => {
  it("add, show, disable, enable against a temp config; real shipped default", () => {
    const xdg = tmp("xdg");
    const env = cleanEnv({ XDG_CONFIG_HOME: xdg });
    const go = (...args) => spawnSync(process.execPath, [BIN, "list", ...args], { env, encoding: "utf8" });
    assert.equal(go("add", "pnpm check", "--show", "verdict").status, 0);
    assert.equal(go("disable", "git fetch").status, 0);
    const shown = go("show");
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /git fetch\s+verdict\s+user\s+disabled/);
    assert.match(shown.stdout, /pnpm check\s+verdict\s+user\s+enabled/);
    assert.match(shown.stdout, /ssh\s+excerpt\s+default\s+enabled/);
    assert.equal(go("enable", "git fetch").status, 0);
    assert.equal(go("bogus").status, 125);
  });
});
