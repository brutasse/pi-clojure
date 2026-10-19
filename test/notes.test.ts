import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffText,
  numberedContent,
  buildChangeNote,
  assembleChangeNotes,
  type ChangeReason,
} from "../extensions/clojure/notes.ts";

test("diffText: identical texts have an empty diff", () => {
  assert.equal(diffText("(def a 1)\n", "(def a 1)\n"), "");
});

test("diffText: common prefix and suffix are trimmed, lines numbered per side", () => {
  const before = "l1\nl2\nOLD\nl4\nl5";
  const after = "l1\nl2\nNEW\nl4\nl5";
  assert.equal(diffText(before, after), "-3: OLD\n+3: NEW");
});

test("diffText: whole-file replacement lists both sides", () => {
  assert.equal(diffText("a\nb", "c\nd"), "-1: a\n-2: b\n+1: c\n+2: d");
});

test("diffText: insertions number against the after version", () => {
  assert.equal(diffText("a\nb\nc", "a\nb\nx\ny\nc"), "+3: x\n+4: y");
});

test("numberedContent: numbers every line", () => {
  assert.equal(numberedContent("a\nb\n"), "1: a\n2: b\n3: ");
  assert.equal(numberedContent(""), "1: ");
});

test("buildChangeNote: small after-content carries the full current file", () => {
  const note = buildChangeNote("a.clj", "(def a 1 (oops\n", "(def a 1)\n", ["repaired"]);
  assert.match(note, /⚠ Auto-repair note: a\.clj/);
  assert.match(note, /repaired automatically/);
  assert.match(note, /Current on-disk content:/);
  assert.match(note, /1: \(def a 1\)/);
});

test("buildChangeNote: large after-content carries a capped diff instead", () => {
  const before = Array.from({ length: 300 }, (_, i) => `line ${i} OLD`).join("\n");
  const after = Array.from({ length: 300 }, (_, i) => `line ${i} NEW`).join("\n");
  const note = buildChangeNote("big.clj", before, after, ["formatted"]);
  assert.doesNotMatch(note, /Current on-disk content:/);
  assert.match(note, /Changed lines/);
  assert.match(note, /-1: line 0 OLD/);
  assert.match(note, /\+1: line 0 NEW/);
  assert.match(note, /more changed lines - re-read/);
});

test("buildChangeNote: both reasons are reported", () => {
  const note = buildChangeNote("a.clj", "(+ 1 2 3", "(+ 1 2 3)\n", ["repaired", "formatted"]);
  assert.match(note, /repaired and cljfmt reformatted/);
});

test("assembleChangeNotes: files that do not fit the budget get a re-read line", () => {
  const first = { file: "a.clj", before: "(def a 1\n", after: "(def a 1)\n", reasons: ["repaired"] as ChangeReason[] };
  const second = { file: "b.clj", before: "(def b 1\n", after: "(def b 1)\n", reasons: ["repaired"] as ChangeReason[] };
  const firstNote = buildChangeNote(first.file, first.before, first.after, first.reasons);
  const combined = assembleChangeNotes([first, second], Buffer.byteLength(firstNote, "utf8"));
  assert.match(combined, /Auto-repair note: a\.clj/);
  assert.match(combined, /1: \(def a 1\)/);
  assert.match(combined, /Auto-repair note: b\.clj - further changes omitted; re-read/);
});
