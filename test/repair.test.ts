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
  REPAIR_WINDOW_BEFORE,
  REPAIR_WINDOW_AFTER,
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
  const broken = ["(a 1)", "", "(b 2", "", "(c 3", "", "(d 4"].join("\n");
  // one proposal that fixes all three forms at once: 3 lines, cap is 2
  const fixed = ["(a 1)", "", "(b 2)", "", "(c 3)", "", "(d 4)"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.ok(declined.rewrote.length > MAX_REPAIR_CHANGED_LINES, JSON.stringify(declined.rewrote));
  assert.match(declined.message, /is never closed/);
  assert.match(declined.message, /more than 2/);

  // the same proposal passes once the cap covers it
  const accepted = await repairSurgically(broken, { maxChangedLines: 4 });
  assert.equal(accepted.status, "repaired");
});

test("repairSurgically: declines a fix that moves delimiters away from the error", async () => {
  const broken = ["(a 1)", "", "", "", "", "", "", "", "(b 2"].join("\n");
  // a legal repair - balanced, and only one closer moved - but the closer it
  // relocates belongs to a form above the error, which is how indent mode
  // closes a form early
  const fixed = ["(a 1", "", "", "", "", "", "", "", "(b 2))"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.deepEqual(declined.rewrote, [1, 9]);
  assert.match(declined.message, /away from the error/);

  // the band is asymmetric: below the error is where a missing closer belongs
  assert.ok(REPAIR_WINDOW_AFTER > REPAIR_WINDOW_BEFORE);
  assert.equal((await repairSurgically(broken, { windowBefore: 8 })).status, "repaired");
});

test("repairSurgically: anchors are the caller's own changed lines", async () => {
  const broken = ["(a 1)", "", "", "", "", "", "", "", "(b 2"].join("\n");
  const fixed = ["(a 1", "", "", "", "", "", "", "", "(b 2))"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  assert.equal((await repairSurgically(broken, { anchors: [1, 2] })).status, "repaired");
});

test("repairSurgically: a closer that belongs far below its opener is still repaired", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `  (println ${i})`).join("\n");
  const whole = `(defn big []\n${body}\n  (inc 1))\n`;
  // the mistake drops the last closer; the scanner reports the opener, and the
  // fix lands twenty-odd lines lower
  const broken = `(defn big []\n${body}\n  (inc 1)\n`;
  assert.deepEqual(scanClojure(broken), [{ kind: "unclosed", line: 1, col: 1, char: "(" }]);

  const result = await repairSurgically(broken);
  assert.equal(result.status, "repaired");
  if (result.status === "repaired") assert.equal(result.text, whole);

  assert.equal((await repairSurgically(broken, { windowAfter: 5 })).status, "declined");
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
  assert.match(result.message, /rewrite \d+ lines/);
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
