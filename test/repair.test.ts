import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isClojureFile,
  hasDelimiterError,
  scanClojure,
  describeScanErrors,
  changedLinesBetween,
  repairSurgically,
  repairText,
  formatWithCljfmt,
  resolveCljfmt,
  MAX_REPAIR_CHANGED_LINES,
  _internals,
} from "../extensions/clojure/repair.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "piclj-repair-"));

afterEach(() => {
  _internals.setRepair();
  _internals.setFormat();
});

/** Uses a fake repair engine for one test; returns the texts it was called with. */
function mockRepair(results: Record<string, { status: "repaired"; text: string } | { status: "unfixable"; message: string } | { status: "error"; message: string }>) {
  const calls: string[] = [];
  _internals.setRepair(async (text) => {
    calls.push(text);
    return results[text] ?? { status: "error", message: `unexpected content ${JSON.stringify(text)}` };
  });
  return calls;
}

// ---------------------------------------------------------------------------
// isClojureFile
// ---------------------------------------------------------------------------

test("isClojureFile: recognized extensions", () => {
  for (const ext of [".clj", ".cljs", ".cljc", ".cljd", ".bb", ".lpy", ".edn"]) {
    assert.ok(isClojureFile(`/tmp/file${ext}`), ext);
    assert.ok(isClojureFile(`/tmp/file${ext.toUpperCase()}`), `${ext} case-insensitive`);
  }
});

test("isClojureFile: unrecognized paths", () => {
  assert.equal(isClojureFile("/tmp/file.py"), false);
  assert.equal(isClojureFile("/tmp/noextension"), false);
  assert.equal(isClojureFile("/tmp/file.cljx"), false);
});

test("isClojureFile: bb shebang detection", () => {
  assert.ok(isClojureFile("/tmp/run", "#!/usr/bin/env bb\n(def x 1)"));
  assert.ok(isClojureFile("/tmp/run", "#!/bin/bb\n(def x 1)"));
  assert.equal(isClojureFile("/tmp/run", "#!/bin/sh\necho hi"), false);
  // extension wins even without content
  assert.ok(isClojureFile("/tmp/x.clj"));
  assert.equal(isClojureFile("/tmp/run"), false);
});

// ---------------------------------------------------------------------------
// hasDelimiterError (the repair pre-gate)
// ---------------------------------------------------------------------------

test("hasDelimiterError: balanced code is clean", () => {
  assert.equal(hasDelimiterError("(defn foo [x] (* x 2))"), false);
  assert.equal(hasDelimiterError("(defn foo [x] (* x 2))\n"), false);
  assert.equal(hasDelimiterError("{:a [1 2] :b #{3 4}}"), false);
  assert.equal(hasDelimiterError("#(identity (inc %))"), false);
  assert.equal(hasDelimiterError(""), false);
  assert.equal(hasDelimiterError("   \n\n  "), false);
  assert.equal(hasDelimiterError("(:a 1 (\"str\" 2) 3)"), false);
});

test("hasDelimiterError: unbalanced delimiters", () => {
  assert.equal(hasDelimiterError("(+ 1 2 3"), true);
  assert.equal(hasDelimiterError("(def x [1)"), true);
  assert.equal(hasDelimiterError("(def x 1))"), true);
  assert.equal(hasDelimiterError("{:a (1 2}"), true);
  assert.equal(hasDelimiterError("(defn f [a b]\n  (when a\n    (do b c"), true);
});

test("hasDelimiterError: strings do not count", () => {
  assert.equal(hasDelimiterError('(def s "(a b")'), false);
  assert.equal(hasDelimiterError('(def s "a \\" ( b")'), false);
  // multi-line string
  assert.equal(hasDelimiterError('(def s "line1\nline2 (")'), false);
  assert.equal(hasDelimiterError("(def s \"foo"), true); // unterminated
});

test("hasDelimiterError: char literals do not count", () => {
  assert.equal(hasDelimiterError("(def c \\( )"), false);
  assert.equal(hasDelimiterError("(def c \\] )"), false);
  assert.equal(hasDelimiterError("(def c \\space )"), false);
  assert.equal(hasDelimiterError("(def cs \\( \\[ \\{ )"), false);
});

test("hasDelimiterError: comments do not count", () => {
  assert.equal(hasDelimiterError("(def x 1) ; todo: fix (this"), false);
  assert.equal(hasDelimiterError("(def x 1)\n; trailing ( comment\n"), false);
});

test("hasDelimiterError: regex literals do not count", () => {
  assert.equal(hasDelimiterError('(def r #"\\(x\\)")'), false);
  assert.equal(hasDelimiterError('(def s #"abc( def x 1)")'), false);
  // unterminated regex
  assert.equal(hasDelimiterError('(def r #"\\(x'), true);
});

// ---------------------------------------------------------------------------
// scanClojure: the same verdict, plus where the delimiters are wrong
// ---------------------------------------------------------------------------

test("scanClojure: balanced code reports no errors", () => {
  const balanced = [
    "(defn foo [x] (* x 2))",
    "{:a [1 2] :b #{3 4}}",
    '(def s "a \\" ( b")',
    '(def s "line1\nline2 (")',
    "(def c \\( \\[ \\{ )",
    '(def r #"abc( def x 1)")',
    "(def x 1) ; todo: fix (this",
    "#!/usr/bin/env bb\n(def x 1)",
    "#{:a #?(:clj 1 :cljs 2)}",
  ];
  for (const text of balanced) {
    assert.deepEqual(scanClojure(text), [], JSON.stringify(text));
  }
});

test("scanClojure: unclosed delimiters are reported outermost first", () => {
  assert.deepEqual(scanClojure("(defn f []\n  (let [x 1]\n    (inc x)\n"), [
    { kind: "unclosed", line: 1, col: 1, char: "(" },
    { kind: "unclosed", line: 2, col: 3, char: "(" },
  ]);
  // a badly truncated file reports at most MAX_UNCLOSED openers
  assert.equal(scanClojure("(a\n(b\n(c\n(d\n(e\n").length, 3);
});

test("scanClojure: closer errors and string errors carry line and column", () => {
  assert.deepEqual(scanClojure("(def x 1))\n"), [
    { kind: "extra-closer", line: 1, col: 10, char: ")" },
  ]);
  assert.deepEqual(scanClojure("{:a [1 2}"), [
    { kind: "mismatched-closer", line: 1, col: 9, char: "}", opener: { char: "[", line: 1 } },
    { kind: "unclosed", line: 1, col: 1, char: "{" },
  ]);
  assert.deepEqual(scanClojure("(def a 1)\n(def s \"foo\n"), [
    { kind: "unterminated-string", line: 2, col: 8, char: '"' },
    { kind: "unclosed", line: 2, col: 1, char: "(" },
  ]);
  assert.deepEqual(scanClojure("(def a 1)\n(def r #\"foo\n"), [
    { kind: "unterminated-regex", line: 2, col: 8, char: '#"' },
    { kind: "unclosed", line: 2, col: 1, char: "(" },
  ]);
});

test("describeScanErrors: wording an agent can act on", () => {
  assert.equal(
    describeScanErrors(scanClojure("(deftest a []\n  (is (= 1 1)\n")),
    "`(` opened at line 1 is never closed; `(` opened at line 2 is never closed",
  );
  assert.equal(describeScanErrors(scanClojure("(def x 1))")), "unexpected `)` at line 1:10");
  assert.equal(
    describeScanErrors(scanClojure("{:a [1 2}")),
    "`}` at line 1:9 does not match `[` opened at line 1; `{` opened at line 1 is never closed",
  );
});

// ---------------------------------------------------------------------------
// changedLinesBetween: what a rewrite actually touched
// ---------------------------------------------------------------------------

test("changedLinesBetween: ignores whitespace and reports changed lines", () => {
  assert.deepEqual(changedLinesBetween("(a 1)\n(b 2)\n", "(a 1)\n(b 2)\n"), []);
  assert.deepEqual(changedLinesBetween("(a 1)\n(b 2)\n", "(a 1)\n(b 2 3)\n"), [2]);
  // reindent alone is not a change
  assert.deepEqual(changedLinesBetween("(a 1)\n    (b 2)\n", "(a 1)\n  (b 2)\n"), []);
  assert.deepEqual(changedLinesBetween("(a 1)\n(d 4)\n", "(a 1)\n(b 2)\n(c 3)\n(d 4)\n"), [2, 3]);
});

// ---------------------------------------------------------------------------
// repairSurgically: the engine's proposal has to stay next to the error
// ---------------------------------------------------------------------------

test("repairSurgically: balanced code never reaches the repair engine", async () => {
  const calls = mockRepair({});
  assert.deepEqual(await repairSurgically("(defn foo [x] (* x 2))\n"), { status: "clean" });
  assert.deepEqual(calls, []);
});

test("repairSurgically: accepts a fix on the error line", async () => {
  const result = await repairSurgically("(+ 1 2 3");
  assert.deepEqual(result, { status: "repaired", text: "(+ 1 2 3)", rewrote: [1] });
});

test("repairSurgically: declines a fix that rewrites too many lines", async () => {
  // the only error is an extra closer on line 1, but the proposal also
  // rewrites lines 3 and 5: 3 lines, cap is 2
  const broken = ["(def x 1))", "", "(b 2)", "", "(c 3)"].join("\n");
  const fixed = ["(def x 1)", "", "(b 22)", "", "(c 33)"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.ok(declined.rewrote.length > MAX_REPAIR_CHANGED_LINES, JSON.stringify(declined.rewrote));
  assert.match(declined.message, /unexpected `\)` at line 1:10/);
  assert.match(declined.message, /more than 2/);

  // the same proposal passes once the cap covers it
  assert.equal((await repairSurgically(broken, { maxChangedLines: 4 })).status, "repaired");
});

test("repairSurgically: declines a fix that moves a closer instead of adding one", async () => {
  const broken = ["(a 1)", "", "", "", "", "", "", "", "(b 2"].join("\n");
  // a legal balance - the file is left balanced - but the closer it applies
  // was taken from the form above the error: a relocation, not a missing
  // closer added where the form ends
  const moved = ["(a 1", "", "", "", "", "", "", "", "(b 2))"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: moved } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.deepEqual(declined.rewrote, [1, 9]);
  assert.match(declined.message, /moves or deletes existing delimiters/);

  // no widening of the band resurrects it: the guard for missing closers is
  // structural, not a distance
  assert.equal((await repairSurgically(broken, { windowBefore: 8, windowAfter: 8 })).status, "declined");
});

test("repairSurgically: anchors are the caller's own changed lines", async () => {
  const broken = ["(a 1))", ...Array.from({ length: 40 }, () => ""), "(b 2)"].join("\n");
  // the error is the extra closer on line 1; the proposal also rewrites line
  // 42, far outside the error's band, but inside the caller's anchors
  const fixed = ["(a 1)", ...Array.from({ length: 40 }, () => ""), "(b 22)"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.match(declined.message, /away from the error/);
  assert.equal((await repairSurgically(broken, { anchors: [42] })).status, "repaired");
});

test("repairSurgically: a closer that belongs far below its opener is still repaired", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `  (println ${i})`).join("\n");
  const whole = `(defn big []\n${body}\n  (inc 1))\n`;
  const broken = `(defn big []\n${body}\n  (inc 1)\n`;
  assert.deepEqual(scanClojure(broken), [{ kind: "unclosed", line: 1, col: 1, char: "(" }]);

  const result = await repairSurgically(broken);
  assert.equal(result.status, "repaired");
  if (result.status === "repaired") assert.equal(result.text, whole);
  // no distance band bounds a missing closer: the band options do not apply
  assert.equal(
    (await repairSurgically(broken, { windowAfter: 5, windowBefore: 1, maxChangedLines: 0 })).status,
    "repaired",
  );
});

test("repairSurgically: a closer 40+ lines below its opener, with a form following the broken one", async () => {
  // the incident shape: a new deftest lands between two balanced deftests,
  // short one closer at its end; the closer belongs 41 lines below the
  // reported opener - far outside the old 30-line band - and the next
  // top-level form must stay a sibling, not get nested inside
  const bodyLines = Array.from({ length: 40 }, (_, i) => `    (is (= ${i} ${i}))`);
  const broken = ["(deftest t", "  (do", ...bodyLines, "", "(deftest next []", "  (is true))"].join("\n");
  // the right repair: both closers appended to the last body line, 41 lines
  // below the reported opener
  const fixed = [
    "(deftest t",
    "  (do",
    ...bodyLines.slice(0, -1),
    `${bodyLines[bodyLines.length - 1]}))`,
    "",
    "(deftest next []",
    "  (is true))",
  ].join("\n");
  // a wrong repair: both closers land at the end of the following form's body
  // line - balanced and a pure insertion, but it nests that form inside the
  // broken one
  const nested = ["(deftest t", "  (do", ...bodyLines, "", "(deftest next []", "  (is true))))"].join("\n");

  mockRepair({
    [broken]: { status: "repaired", text: fixed },
  });
  const result = await repairSurgically(broken);
  assert.equal(result.status, "repaired");
  if (result.status === "repaired") assert.equal(result.text, fixed);

  // the same distance is refused when the closer lands past the form's end
  mockRepair({ [broken]: { status: "repaired", text: nested } });
  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.match(declined.message, /outside the unclosed forms/);

  // and real parinfer fixes the incident shape end to end
  _internals.setRepair();
  const real = await repairSurgically(broken);
  assert.equal(real.status, "repaired");
  if (real.status === "repaired") {
    assert.deepEqual(scanClojure(real.text), []);
    assert.match(real.text, /\n\(deftest next \[\]/);
  }
});

test("repairSurgically: a proposal that does not fix the code is declined", async () => {
  const broken = "(+ 1 2 3";
  mockRepair({ [broken]: { status: "repaired", text: "(+ 1 2 (3" } });
  const stillBroken = await repairSurgically(broken);
  assert.equal(stillBroken.status, "declined");
  if (stillBroken.status === "declined") assert.match(stillBroken.message, /still leave delimiter errors/);

  mockRepair({ [broken]: { status: "repaired", text: broken } });
  const unchanged = await repairSurgically(broken);
  assert.equal(unchanged.status, "declined");
  if (unchanged.status === "declined") assert.match(unchanged.message, /changed nothing/);
});

test("repairSurgically: a declined unclosed repair says where the closer belongs", async () => {
  const broken = "(+ 1 2 3";
  mockRepair({ [broken]: { status: "repaired", text: broken } });
  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.match(declined.message, /opened at line 1 is never closed/);
  assert.match(declined.message, /the missing closer belongs at the end of the form opened on line 1/);
});

test("repairSurgically: engine status is passed through", async () => {
  const broken = "(+ 1 2 3";
  mockRepair({ [broken]: { status: "error", message: "engine down" } });
  assert.deepEqual(await repairSurgically(broken), { status: "error", message: "engine down" });

  mockRepair({ [broken]: { status: "unfixable", message: "unclosed string" } });
  assert.deepEqual(await repairSurgically(broken), { status: "unfixable", message: "unclosed string" });
});

test("repairSurgically: real parinfer against indentation drift", async () => {
  // the file was balanced and badly indented; the model's edit then dropped a
  // closer. Reading indentation as the truth, parinfer closes the earlier forms
  // where the indentation says they end, which rewrites unrelated code.
  const drifted = [
    "(deftest drift-test []", //
    "(when true", //
    "(is true)))", //
    "", //
    "(deftest new-test []", //
    '  (is (= 1', //
    "        (inc 0)))", //
    "", //
  ].join("\n");
  assert.deepEqual(scanClojure(drifted), [{ kind: "unclosed", line: 5, col: 1, char: "(" }]);

  const result = await repairSurgically(drifted, { anchors: [5, 6, 7] });
  assert.equal(result.status, "declined");
  if (result.status !== "declined") return;
  assert.ok(result.rewrote.includes(1), "the drift repair reaches back to line 1");
  assert.match(result.message, /opened at line 5 is never closed/);
  assert.match(result.message, /moves or deletes existing delimiters/);
});

// ---------------------------------------------------------------------------
// repairText: real parinfer, indent mode
// ---------------------------------------------------------------------------

test("repairText: real parinfer, indent mode", () => {
  assert.deepEqual(repairText("(+ 1 2 3"), { status: "repaired", text: "(+ 1 2 3)" });
  assert.deepEqual(repairText("(defn add [a b]\n  (+ a b"), {
    status: "repaired",
    text: "(defn add [a b]\n  (+ a b))",
  });
  assert.equal(repairText("#(\"foo").status, "unfixable");
  assert.deepEqual(repairText("(def x 1)"), { status: "repaired", text: "(def x 1)" });
});

// ---------------------------------------------------------------------------
// formatWithCljfmt
// ---------------------------------------------------------------------------

function withPath(dir: string, fn: () => Promise<void>) {
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  _internals.resetCljfmtCache();
  return fn().finally(() => {
    process.env.PATH = oldPath;
    _internals.resetCljfmtCache();
  });
}

test("formatWithCljfmt: no cljfmt on PATH returns input unchanged", async () => {
  const emptyDir = mkdtempSync(path.join(tmp, "empty-path"));
  await withPath(emptyDir, async () => {
    assert.equal(resolveCljfmt(), null);
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: invokes cljfmt fix - with stdin", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt"));
  // identity formatter in pure shell (the test overrides PATH, so no cat)
  writeFileSync(
    path.join(fakeDir, "cljfmt"),
    "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
    { mode: 0o755 },
  );
  await withPath(fakeDir, async () => {
    assert.match(resolveCljfmt() ?? "", /cljfmt$/);
    assert.equal(await formatWithCljfmt("(def x 1)\n"), "(def x 1)\n");
  });
});

test("formatWithCljfmt: whitespace-only output is applied", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt-reindent"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nprintf '(def x\\n  1)\\n'\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x\n1)"), "(def x\n  1)\n");
  });
});

test("formatWithCljfmt: output that changes code is discarded", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt-out"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nprintf '(def x 2)\\n'\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    // cljfmt moves whitespace; anything else is treated as a broken tool rather
    // than written over the author's code
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: empty output cannot empty the file", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt-empty"));
  // reads stdin, exits 0, writes nothing: what cljfmt does when it chokes
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nwhile IFS= read -r line; do :; done\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: unparseable input is reported, not written back", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt-unparseable"));
  // real cljfmt exits 0 with empty stdout and this on stderr when it cannot
  // read the forms
  writeFileSync(
    path.join(fakeDir, "cljfmt"),
    "#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf 'Failed to format file: STDIN\\n' >&2\n",
    { mode: 0o755 },
  );
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x (1"), "(def x (1");
  });
});

test("formatWithCljfmt: failing cljfmt fails open", async () => {
  const fakeDir = mkdtempSync(path.join(tmp, "fake-cljfmt-fail"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\necho broken >&2\nexit 1\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: real cljfmt when available", async (t) => {
  _internals.resetCljfmtCache();
  const bin = resolveCljfmt();
  if (!bin) {
    t.skip("cljfmt not on PATH");
    return;
  }
  const out = await formatWithCljfmt("(defn foo [x]\n(* x 2)\n)\n");
  assert.equal(out, "(defn foo [x]\n  (* x 2))\n");
});
