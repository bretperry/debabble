// Import walk: every file under src/ and bin/ imports only node builtins or its own relative files, so the package has no dependencies.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: node builtins only.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = (dir) => readdirSync(join(ROOT, dir)).filter((name) => name.endsWith(".mjs")).map((name) => join(ROOT, dir, name));
const specifiers = (file) => [...readFileSync(file, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

describe("imports", () => {
  it("src and bin import only node: builtins and relative files that exist", () => {
    const all = [...files("src"), ...files("bin")];
    assert.ok(all.length >= 6);
    for (const file of all) {
      for (const spec of specifiers(file)) {
        if (spec.startsWith(".")) assert.ok(existsSync(resolve(dirname(file), spec)), `${file} → ${spec}`);
        else assert.ok(spec.startsWith("node:") && builtinModules.includes(spec.slice(5)), `${file} imports ${spec}`);
      }
    }
  });

  it("package.json has no dependencies and no install-time script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[key], undefined, key);
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[hook], undefined, hook);
  });
});
