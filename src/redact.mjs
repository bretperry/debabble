// Masks secret-shaped text in what debabble prints (the label, verdict line and excerpt), never in the log file.
// In the app: a library module; cli.mjs passes a line redactor to scanLog and runs the label and error text through redactText.
// Used by: src/cli.mjs, src/index.mjs; tested by test/redact.test.mjs.
// Uses: nothing.
// Exports: SHAPES (names, in the order they are tried), redactText(text), lineRedactor().
//
// Shapes (high precision only; each hit becomes `<redacted:<shape>>`):
//   pem-private-key   `-----BEGIN … PRIVATE KEY-----` through its END line (a missing END masks to the end of the text)
//   github-token      `gh[pousr]_` + 20 or more letters and digits
//   sk-key            `sk-` + 20 or more letters, digits, `-` or `_` (not inside a longer word, so `task-…` is left alone)
//   aws-access-key    `AKIA` + 16 capitals and digits
//   slack-token       `xox[abprs]-` + 10 or more letters, digits or `-`
//   jwt               `eyJ…` header, `eyJ…` payload, then the signature (may be empty)
//   url-credentials   the `user:pass` of `scheme://user:pass@host` (scheme and host stay; `$VAR`, `{…}`, `<…>` and `%s` passwords are templates, not secrets)
// Not masked on purpose: `secret=…`, `token: …`, `Authorization: Bearer …`, `.env`-style lines. In a 14-day scan they matched source and docs far
// more often than secrets.
//
// Two ways in. redactText masks a whole string (a PEM block may span lines). lineRedactor() returns a function for one line at a time, in
// order, that remembers whether it is inside a PEM block, so a block is masked line by line even when an excerpt shows only some of its lines.

const PEM_HEAD = String.raw`-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----`;
const PEM_BEGIN = new RegExp(PEM_HEAD);
const PEM_BLOCK = new RegExp(String.raw`${PEM_HEAD}[\s\S]*?(?:-----END \1-----|$)`, "g");

// The shapes that sit on one line, as [name, pattern, replacement].
const LINE_SHAPES = [
  ["github-token", /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, "<redacted:github-token>"],
  ["sk-key", /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, "<redacted:sk-key>"],
  ["aws-access-key", /(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])/g, "<redacted:aws-access-key>"],
  ["slack-token", /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted:slack-token>"],
  ["jwt", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<redacted:jwt>"],
  ["url-credentials", /(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@'"<>]+:(?![$<{%])[^\s/@'"<>]+@/g, "<redacted:url-credentials>@"],
];
export const SHAPES = ["pem-private-key", ...LINE_SHAPES.map(([name]) => name)];

// A line with none of these can hold no shape: one scan decides, so the many lines of a long log pay for one regex, not seven.
const ANCHOR = /-----|gh[pousr]_|sk-|AKIA|xox[abprs]-|eyJ|:\/\//;

const PEM_MASK = "<redacted:pem-private-key>";
// A line that can sit inside a PEM block: base64, a `Proc-Type: 4,ENCRYPTED` style header, or a blank. Anything else (code, a sentence with
// quotes or brackets) ends a block that never closed.
const PEM_BODY = /^[A-Za-z0-9+/=:,. \t-]*$/;
// A key is under 100 lines (4096-bit RSA is about 52); a block that stays open longer is not one.
const PEM_MAX_LINES = 100;

const maskLineShapes = (text) => {
  if (!ANCHOR.test(text)) return text;
  let out = text;
  for (const [, pattern, mask] of LINE_SHAPES) out = out.replace(pattern, mask);
  return out;
};

// `text` with every shape masked. Idempotent: a mask matches no shape.
export const redactText = (text) => {
  if (typeof text !== "string" || !ANCHOR.test(text)) return text;
  return maskLineShapes(text.replace(PEM_BLOCK, PEM_MASK));
};

// A function that masks one line at a time; call it on the lines of one output in order. Inside a PEM block every line is the mask.
export const lineRedactor = () => {
  let inKey = false;
  let left = 0;
  return (line) => {
    if (inKey) {
      const end = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.exec(line);
      if (end) {
        inKey = false;
        return `${PEM_MASK}${maskLineShapes(line.slice(end.index + end[0].length))}`;
      }
      left -= 1;
      if (left > 0 && PEM_BODY.test(line)) return PEM_MASK;
      inKey = false; // never closed: this line is ordinary output
    }
    if (!ANCHOR.test(line)) return line;
    const begin = PEM_BEGIN.exec(line);
    if (!begin) return maskLineShapes(line);
    const before = maskLineShapes(line.slice(0, begin.index));
    const rest = line.slice(begin.index);
    const closed = new RegExp(`${PEM_HEAD}[\\s\\S]*?-----END \\1-----`).exec(rest);
    if (closed) return `${before}${PEM_MASK}${lineRedactorTail(rest.slice(closed[0].length))}`;
    inKey = true;
    left = PEM_MAX_LINES;
    return `${before}${PEM_MASK}`;
  };
};

// What follows a block's END on its line may hold a second block or another shape.
const lineRedactorTail = (text) => lineRedactor()(text);
