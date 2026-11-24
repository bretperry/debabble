// Tests for src/redact.mjs: each shape is masked with its name, ordinary code and docs text is left alone, and a PEM block is masked line by line.
// In the app: nothing at runtime. Run: `node --test`.
// Used by: `npm test`.
// Uses: src/redact.mjs.
// Fixtures are built from pieces at run time, so no secret-shaped literal sits in this file (push scanners would flag it).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHAPES, lineRedactor, redactText } from "../src/redact.mjs";

const pad = (n, ch = "a") => ch.repeat(n);
const DASHES = "-".repeat(5);
const BEGIN = (kind = "PRIVATE KEY") => `${DASHES}BEGIN ${kind}${DASHES}`;
const END = (kind = "PRIVATE KEY") => `${DASHES}END ${kind}${DASHES}`;
const PEM = (kind = "RSA PRIVATE KEY") => [BEGIN(kind), "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn", "Zm9vYmFyYmF6cXV4", END(kind)];
const JWT = `${"ey" + "J"}hbGciOiJIUzI1NiJ9.${"ey" + "J"}zdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpM`;

// One case per shape: [shape, text with the secret, the secret, what the text becomes].
const CASES = [
  ["github-token", `token ${"gh" + "p_"}${pad(36, "A")} used`, `${"gh" + "p_"}${pad(36, "A")}`, "token <redacted:github-token> used"],
  ["github-token", `${"gh" + "s_"}${pad(20, "b")}`, `${"gh" + "s_"}${pad(20, "b")}`, "<redacted:github-token>"],
  ["sk-key", `key=${"s" + "k-"}${pad(48, "Z9")}`, `${"s" + "k-"}${pad(48, "Z9")}`, "key=<redacted:sk-key>"],
  ["sk-key", `${"s" + "k-"}ant-api03-${pad(20, "x")}_-`, "", "<redacted:sk-key>"],
  ["aws-access-key", `id ${"AK" + "IA"}ABCDEFGHIJKLMNOP.`, `${"AK" + "IA"}ABCDEFGHIJKLMNOP`, "id <redacted:aws-access-key>."],
  ["slack-token", `${"xo" + "xb"}-123456789012-abcdefABCDEF`, "", "<redacted:slack-token>"],
  ["slack-token", `x ${"xo" + "xp"}-1234567890-1234567890-abc y`, "", "x <redacted:slack-token> y"],
  ["jwt", `Authorization: Bearer ${JWT}`, JWT, "Authorization: Bearer <redacted:jwt>"],
  ["jwt", `${"ey" + "J"}hbGciOiJub25lIn0.${"ey" + "J"}zdWIiOiIxIn0.`, "", "<redacted:jwt>"],
  ["url-credentials", "git clone https://alice:hunter2@example.com/org/repo.git", "alice:hunter2", "git clone https://<redacted:url-credentials>@example.com/org/repo.git"],
  ["url-credentials", "postgres://admin:p%40ss@db.internal:5432/app", "admin:p%40ss", "postgres://<redacted:url-credentials>@db.internal:5432/app"],
  ["pem-private-key", PEM().join("\n"), "MIIEow", "<redacted:pem-private-key>"],
  ["pem-private-key", `before ${PEM("OPENSSH PRIVATE KEY").join("\n")} after`, "Zm9vYmFy", "before <redacted:pem-private-key> after"],
  ["pem-private-key", PEM("ENCRYPTED PRIVATE KEY").join("\n"), "MIIEow", "<redacted:pem-private-key>"],
  ["pem-private-key", PEM("PGP PRIVATE KEY BLOCK").join("\n"), "MIIEow", "<redacted:pem-private-key>"],
];

describe("redactText: one case per shape", () => {
  for (const [shape, input, secret, expected] of CASES) {
    it(`masks ${shape}: ${input.slice(0, 24).replace(/\n/g, "⏎")}…`, () => {
      const out = redactText(input);
      assert.equal(out, expected);
      assert.match(out, new RegExp(`<redacted:${shape}>`));
      if (secret) assert.equal(out.includes(secret), false);
    });
  }

  it("every shape in SHAPES has a case", () => {
    assert.deepEqual([...new Set(CASES.map(([shape]) => shape))].toSorted(), [...SHAPES].toSorted());
  });

  it("masks several shapes on one line, and every hit of one shape", () => {
    const line = `a ${"gh" + "p_"}${pad(30)} b ${"gh" + "o_"}${pad(30)} c https://u:p@h/ ${JWT}`;
    assert.equal(redactText(line), "a <redacted:github-token> b <redacted:github-token> c https://<redacted:url-credentials>@h/ <redacted:jwt>");
  });

  it("an unterminated PEM block is masked to the end of the text", () => {
    assert.equal(redactText(`x\n${BEGIN()}\nMIIE\nmore`), "x\n<redacted:pem-private-key>");
  });

  it("is idempotent", () => {
    for (const [, input] of CASES) assert.equal(redactText(redactText(input)), redactText(input));
  });

  it("passes non-strings through", () => {
    assert.equal(redactText(undefined), undefined);
  });
});

// Ordinary code and docs text: none of it may change.
const CORPUS = [
  "const token = process.env.API_TOKEN;",
  "secret=changeme",
  "token: abc123",
  "password = getPassword()",
  "Authorization: Bearer ${TOKEN}",
  "API_KEY=your-key-here",
  "export OPENAI_API_KEY=<your key>",
  "curl -H 'Authorization: Bearer $TOKEN' https://api.example.com/v1",
  "see https://example.com:8080/path@x and http://localhost:3000/",
  "git remote add origin git@github.com:org/repo.git",
  "ssh://git@github.com:22/org/repo.git",
  "postgres://$USER:$PASS@localhost/db",
  "https://${USER}:${PASS}@host/path",
  "mysql://<user>:<password>@host/db",
  "the task-runner-configuration-file-for-everything",
  "flask-sk-learn style names: sk-learn, ask-me-anything",
  "disk-usage-report-for-all-volumes-on-this-machine",
  "xoxb- tokens start with the xoxb- prefix",
  "AKIA is the prefix; AKIAIOSFODNN7 is too short",
  "ghp_ is the prefix for personal tokens; ghp_short stays",
  "eyJ is how base64 JSON starts; eyJhbGciOi.short",
  "-----BEGIN CERTIFICATE-----",
  "MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ",
  "-----END CERTIFICATE-----",
  "-----BEGIN PUBLIC KEY-----",
  "src/redact.mjs:42:  return text.replace(/-----BEGIN/g, '');",
  "    at Object.<anonymous> (/work/app/src/index.js:10:15)",
  "ok 12 - sk-prefixed ids are parsed",
  "1) AssertionError: expected 3 to equal 4",
  "FAIL src/a.test.ts > adds two numbers",
  "https://example.com/a/b?c=d#e user@example.com",
  "a.b.c d.e.f 0.1.2",
  "Compiling serde v1.0.190",
];

describe("false-positive corpus", () => {
  it("ordinary code and docs text comes out unchanged", () => {
    for (const text of CORPUS) assert.equal(redactText(text), text, text);
  });

  it("and through the line redactor", () => {
    const redact = lineRedactor();
    for (const text of CORPUS) assert.equal(redact(text), text, text);
  });
});

describe("lineRedactor", () => {
  it("masks a PEM block line by line, including a block whose first lines were never shown", () => {
    const redact = lineRedactor();
    const out = ["start", ...PEM(), "after"].map((line) => redact(line));
    assert.deepEqual(out, ["start", "<redacted:pem-private-key>", "<redacted:pem-private-key>", "<redacted:pem-private-key>", "<redacted:pem-private-key>", "after"]);
  });

  it("keeps text before the BEGIN and after the END on their lines", () => {
    const redact = lineRedactor();
    assert.equal(redact(`key: ${BEGIN()}`), "key: <redacted:pem-private-key>");
    assert.equal(redact("MIIEvQIBADANBgkq"), "<redacted:pem-private-key>");
    assert.equal(redact(`${END()} done https://u:p@h/`), "<redacted:pem-private-key> done https://<redacted:url-credentials>@h/");
  });

  it("a block with its BEGIN and END on one line is masked on that line", () => {
    const redact = lineRedactor();
    assert.equal(redact(`a ${BEGIN()}MIIE${END()} b`), "a <redacted:pem-private-key> b");
    assert.equal(redact("next line"), "next line");
  });

  it("a block that never closes ends at the first line that is not key text", () => {
    const redact = lineRedactor();
    assert.equal(redact(BEGIN()), "<redacted:pem-private-key>");
    assert.equal(redact("MIIEvQIBADANBgkq"), "<redacted:pem-private-key>");
    assert.equal(redact("const x = foo('bar');"), "const x = foo('bar');");
    assert.equal(redact("MIIEvQIBADANBgkq"), "MIIEvQIBADANBgkq");
  });

  it("a block that never closes ends after 100 lines", () => {
    const redact = lineRedactor();
    redact(BEGIN());
    const shown = Array.from({ length: 150 }, () => redact("QUJDREVGRw==")).filter((line) => line === "QUJDREVGRw==");
    assert.ok(shown.length >= 49 && shown.length <= 51, `${shown.length} lines shown`);
  });

  it("masks a one-line shape the same as redactText", () => {
    const redact = lineRedactor();
    for (const [, input] of CASES.filter(([shape]) => shape !== "pem-private-key")) assert.equal(redact(input), redactText(input));
  });
});
