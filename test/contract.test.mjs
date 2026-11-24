// Tests that debabble reads its argv and picks its log base exactly as test/fixtures/guard-contract.json says, the file a guard (shell-bouncer)
// reads to judge a debabble line without running it. A change here that breaks the fixture breaks that guard's reading too: update both.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/cli.mjs (parseArgs), src/logs.mjs (logBase), bin/debabble.mjs (runs-nothing and usage-error cases, end to end).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli.mjs";
import { logBase } from "../src/logs.mjs";
import { BIN, cleanEnv, tmp } from "./helpers.mjs";

const CONTRACT = JSON.parse(readFileSync(new URL("./fixtures/guard-contract.json", import.meta.url), "utf8"));

describe("guard contract: argv", () => {
  for (const { argv, result, command, args } of CONTRACT.argv) {
    it(`${JSON.stringify(argv)} → ${result}`, () => {
      const marker = join(tmp("contract"), "ran");
      const real = argv.map((word) => (word === "MARKER" ? marker : word));
      if (result === "runs-command") {
        // The bin sends every argv but `hook …`, `list …` and a lone `--version` to the CLI, which runs what parseArgs returns.
        assert.notEqual(real[0], "hook");
        assert.notEqual(real[0], "list");
        const parsed = parseArgs(real, {});
        assert.equal(parsed.error, undefined);
        assert.equal(parsed.command, command);
        assert.deepEqual(parsed.args, args);
        return;
      }
      // none and usage-error: through the bin, which must run nothing (MARKER is never made) and exit 0 or 125.
      const ran = spawnSync(process.execPath, [BIN, ...real], { input: "", env: cleanEnv({ XDG_CONFIG_HOME: tmp("xdg") }), encoding: "utf8" });
      assert.equal(ran.status, result === "none" ? 0 : 125, ran.stderr);
      assert.equal(existsSync(marker), false);
      if (result === "usage-error") assert.ok(parseArgs(real, {}).error);
    });
  }
});

describe("guard contract: log base", () => {
  for (const { env, flag, home, base } of CONTRACT.logBase) {
    it(`${JSON.stringify(env)} with --log-dir ${flag} → ${base}`, () => {
      const saved = process.env.HOME;
      process.env.HOME = home;
      try {
        assert.equal(logBase(env, flag ?? undefined), base);
      } finally {
        process.env.HOME = saved;
      }
    });
  }
});
