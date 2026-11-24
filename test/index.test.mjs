// The library entry exports exactly run, scan, excerpt, and they work together on a real command.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/index.mjs.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lib from "../src/index.mjs";
import { tmp } from "./helpers.mjs";

describe("library", () => {
  it("exports run, scan and excerpt, and nothing else", () => {
    assert.deepEqual(Object.keys(lib).toSorted(), ["excerpt", "run", "scan"]);
  });

  it("run → scan → excerpt shows the failure of a failing command", async () => {
    const root = tmp();
    const logFile = join(root, "x.log");
    writeFileSync(logFile, "");
    const ran = await lib.run({ command: process.execPath, args: ["-e", "console.error('Error: nope'); process.exit(2)"], cwd: root, logFile });
    assert.equal(ran.status, 2);
    assert.deepEqual(lib.excerpt(lib.scan(logFile)), ["Error: nope"]);
  });
});
