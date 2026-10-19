import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import clojure, { handleToolCall, handleToolResult } from "../extensions/clojure/index.ts";
import { _internals as repairInternals, type RepairResult } from "../extensions/clojure/repair.ts";
import { _internals as nreplInternals } from "../extensions/clojure/nrepl.ts";
import { FakeNrepl, waitFor } from "./fake-nrepl.ts";

// ---------------------------------------------------------------------------
// harness: a fake ExtensionAPI recording handlers and registered tools
// ---------------------------------------------------------------------------

interface Harness {
  tools: Map<string, any>;
  ctx: { cwd: string; signal: AbortSignal };
  toolCall: (toolName: string, toolCallId: string, input: unknown) => Promise<any>;
  toolResult: (
    toolName: string,
    toolCallId: string,
    input: unknown,
    text: string,
    isError?: boolean,
  ) => Promise<any>;
  shutdown: () => Promise<void>;
}

function harness(cwd: string): Harness {
  const handlers = new Map<string, ((event: any, ctx: any) => Promise<any>)[]>();
  const tools = new Map<string, any>();
  const pi: any = {
    on(event: string, handler: any) {
      const list = handlers.get(event) ?? [];
      handlers.set(event, [...list, handler]);
      return () => {};
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  clojure(pi);
  const ctx = { cwd, signal: new AbortController().signal };

  const fire = async (event: string, payload: any) => {
    let result: any;
    for (const handler of handlers.get(event) ?? []) {
      const next = await handler(payload, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };

  return {
    tools,
    ctx,
    toolCall: (toolName, toolCallId, input) => fire("tool_call", { type: "tool_call", toolName, toolCallId, input }),
    toolResult: (toolName, toolCallId, input, text, isError = false) =>
      fire("tool_result", {
        type: "tool_result",
        toolName,
        toolCallId,
        input,
        content: [{ type: "text", text }],
        details: undefined,
        isError,
      }),
    shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
  };
}

const tmp = mkdtempSync(path.join(tmpdir(), "piclj-ext-"));
let callId = 0;
const nextID = () => `call-${++callId}`;

/** Mock repair keyed by the content it is called with. */
function mockRepair(results: Record<string, RepairResult>) {
  const calls: string[] = [];
  repairInternals.setRepair(async (text) => {
    calls.push(text);
    return results[text] ?? { status: "error", message: `unexpected content ${text}` };
  });
  return calls;
}

/** Mock formatter; `transform` defaults to the identity. */
function mockFormat(transform?: (text: string) => string) {
  const calls: string[] = [];
  repairInternals.setFormat(async (text) => {
    calls.push(text);
    return transform ? transform(text) : text;
  });
  return calls;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return (content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

afterEach(async () => {
  repairInternals.setRepair();
  repairInternals.setFormat();
  repairInternals.resetCljfmtCache();
  nreplInternals.resetNreplPool();
});

// ---------------------------------------------------------------------------
// write: the tool_call handler repairs the input
// ---------------------------------------------------------------------------

test("write call: broken content is repaired and formatted in place", async () => {
  const repairs = mockRepair({ "(+ 1 2 3": { status: "repaired", text: "(+ 1 2 3)" } });
  const formats = mockFormat((t) => t + "\n");
  const input = { path: "foo.clj", content: "(+ 1 2 3" };
  const result = await harness(tmp).toolCall("write", nextID(), input);
  assert.equal(result, undefined);
  assert.deepEqual(repairs, ["(+ 1 2 3"]);
  assert.deepEqual(formats, ["(+ 1 2 3)"]);
  assert.equal(input.content, "(+ 1 2 3)\n");
});

test("write call: balanced content skips repair but still formats", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  const input = { path: "foo.clj", content: "(def x 1)\n" };
  await harness(tmp).toolCall("write", nextID(), input);
  assert.equal(repairs.length, 0);
  assert.deepEqual(formats, ["(def x 1)\n"]);
  assert.equal(input.content, "(def x 1)\n");
});

test("write call: unfixable content blocks the call with the reason", async () => {
  mockRepair({ '#("foo': { status: "unfixable", message: "String is missing a closing quote." } });
  mockFormat();
  const input = { path: "foo.clj", content: '#("foo' };
  const result = await harness(tmp).toolCall("write", nextID(), input);
  assert.equal(result.block, true);
  assert.match(result.reason, /foo\.clj/);
  assert.match(result.reason, /could not be auto-fixed/);
  assert.equal(input.content, '#("foo'); // untouched
});

test("write call: repair failure fails open", async () => {
  mockRepair({ "(+ 1 2 3": { status: "error", message: "boom" } });
  const formats = mockFormat();
  const input = { path: "foo.clj", content: "(+ 1 2 3" };
  await harness(tmp).toolCall("write", nextID(), input);
  assert.equal(input.content, "(+ 1 2 3");
  // the un-repaired content still gets the formatting attempt
  assert.deepEqual(formats, ["(+ 1 2 3"]);
});

test("write call: non-Clojure files are skipped", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  const h = harness(tmp);
  await h.toolCall("write", nextID(), { path: "foo.py", content: "x = 1" });
  await h.toolCall("write", nextID(), { path: "foo", content: "no extension" });
  assert.equal(repairs.length, 0);
  assert.equal(formats.length, 0);
});

test("write call: bb shebang content is processed", async () => {
  const shebang = "#!/usr/bin/env bb\n(def x 1";
  mockRepair({ [shebang]: { status: "repaired", text: `${shebang})` } });
  mockFormat();
  const input = { path: "scripts/run", content: shebang };
  await harness(tmp).toolCall("write", nextID(), input);
  assert.equal(input.content, `${shebang})`);
});

test("write call: malformed input is ignored", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  const h = harness(tmp);
  await h.toolCall("write", nextID(), { path: "foo.clj" });
  await h.toolCall("write", nextID(), {});
  await h.toolCall("read", nextID(), { path: "foo.clj", content: "(+ 1 2 3" });
  assert.equal(repairs.length, 0);
  assert.equal(formats.length, 0);
});

// ---------------------------------------------------------------------------
// write: the tool_result handler reports what landed on disk
// ---------------------------------------------------------------------------

test("write result: modified content gets a change note appended", async () => {
  const h = harness(tmp);
  const id = nextID();
  mockRepair({ "(def w 1": { status: "repaired", text: "(def w 1)" } });
  mockFormat();
  const input = { path: "w.clj", content: "(def w 1" };
  await h.toolCall("write", id, input);
  writeFileSync(path.join(tmp, "w.clj"), input.content, "utf8"); // the write tool applied it
  const result = await h.toolResult("write", id, input, "Successfully wrote to w.clj");
  const text = resultText(result?.content);
  assert.match(text, /^Successfully wrote to w\.clj/);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /repaired automatically/);
  assert.match(text, /1: \(def w 1\)/);
});

test("write result: unmodified content gets no note", async () => {
  const h = harness(tmp);
  const id = nextID();
  mockRepair({});
  mockFormat();
  const input = { path: "w2.clj", content: "(def w 1)\n" };
  await h.toolCall("write", id, input);
  writeFileSync(path.join(tmp, "w2.clj"), input.content, "utf8");
  const result = await h.toolResult("write", id, input, "ok");
  assert.equal(result, undefined);
});

test("write result: failed call gets no note", async () => {
  const h = harness(tmp);
  const id = nextID();
  mockRepair({ "(def w 1": { status: "repaired", text: "(def w 1)" } });
  mockFormat();
  const input = { path: "w3.clj", content: "(def w 1" };
  await h.toolCall("write", id, input);
  const result = await h.toolResult("write", id, input, "n/a", true);
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// edit: back up before, repair after
// ---------------------------------------------------------------------------

test("edit: repaired file gets written back and a change note with the content", async () => {
  const file = path.join(tmp, "a.clj");
  writeFileSync(file, "(def a 1)\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "a.clj", edits: [{ oldText: "1", newText: "1 (oops" }] });
  writeFileSync(file, "(def a 1 (oops\n", "utf8"); // simulate the applied edit
  mockRepair({ "(def a 1 (oops\n": { status: "repaired", text: "(def a 1)\n" } });
  mockFormat();
  const result = await h.toolResult("edit", id, { path: "a.clj" }, "Successfully replaced 1 block(s) in a.clj.");
  assert.equal(readFileSync(file, "utf8"), "(def a 1)\n");
  const text = resultText(result?.content);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /repaired automatically/);
  assert.match(text, /Current on-disk content:/);
  assert.match(text, /1: \(def a 1\)/);
});

test("edit: cljfmt-only change still gets written back and noticed", async () => {
  const file = path.join(tmp, "a2.clj");
  writeFileSync(file, "(def a 2)\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "a2.clj", edits: [{ oldText: "1", newText: "2" }] });
  mockRepair({});
  mockFormat((t) => t.replace("2", "3")); // simulate a cljfmt change
  const result = await h.toolResult("edit", id, { path: "a2.clj" }, "ok");
  assert.equal(readFileSync(file, "utf8"), "(def a 3)\n");
  const text = resultText(result?.content);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /cljfmt reformatted/);
  assert.match(text, /1: \(def a 3\)/);
});

test("edit: balanced and unformatted file is left alone", async () => {
  const file = path.join(tmp, "a3.clj");
  writeFileSync(file, "(def a 2)\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "a3.clj", edits: [{ oldText: "x", newText: "y" }] });
  const repairs = mockRepair({});
  mockFormat(); // identity formatting: no change
  const result = await h.toolResult("edit", id, { path: "a3.clj" }, "ok");
  assert.equal(repairs.length, 0);
  assert.equal(readFileSync(file, "utf8"), "(def a 2)\n");
  assert.equal(result, undefined); // no notice added
});

test("edit: unfixable file is restored and the result rewritten as an error", async () => {
  const file = path.join(tmp, "b.clj");
  writeFileSync(file, "(def b 1)\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "b.clj", edits: [{ oldText: "1", newText: "1 (oops" }] });
  writeFileSync(file, "(def b 1 (oops\n", "utf8");
  mockRepair({ "(def b 1 (oops\n": { status: "unfixable", message: "unfixable" } });
  mockFormat();
  const result = await h.toolResult("edit", id, { path: "b.clj" }, "Successfully replaced 1 block(s).");
  assert.equal(readFileSync(file, "utf8"), "(def b 1)\n");
  assert.equal(result.isError, true);
  assert.match(resultText(result?.content), /was reverted/);
  assert.match(resultText(result?.content), /retry the edit/);
});

test("edit: a repair that would move unrelated delimiters restores the file", async () => {
  // a balanced file whose indentation contradicts its delimiters, the case
  // parinfer's indent mode reads as "these forms end here": repairing the
  // missing closer below would also close the first deftest early
  const before = "(deftest drift-test []\n(when true\n(is true)))\n";
  const edited = "(deftest drift-test []\n(when true\n(is true)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  const file = path.join(tmp, "drift.clj");
  writeFileSync(file, before, "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "drift.clj", edits: [{ oldText: "(is true)))", newText: "(is true)))" }] });
  writeFileSync(file, edited, "utf8");
  mockFormat(); // the real parinfer engine decides

  const result = await h.toolResult("edit", id, { path: "drift.clj" }, "Successfully replaced 1 block(s).");
  assert.equal(readFileSync(file, "utf8"), before, "the pre-edit content is back byte for byte");
  assert.equal(result.isError, true);
  assert.match(resultText(result?.content), /was reverted/);
  assert.match(resultText(result?.content), /opened at line 5 is never closed/);
  assert.match(resultText(result?.content), /rewrite 4 lines \(1, 2, 3, 7\)/);
});

test("edit: the same missing closer in a well-indented file is repaired", async () => {
  const before = "(deftest a-test []\n  (is (= 1 1)))\n";
  const edited = "(deftest a-test []\n  (is (= 1 1)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  const file = path.join(tmp, "clean.clj");
  writeFileSync(file, before, "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "clean.clj", edits: [{ oldText: "1", newText: "1" }] });
  writeFileSync(file, edited, "utf8");
  mockFormat();

  const result = await h.toolResult("edit", id, { path: "clean.clj" }, "Successfully replaced 1 block(s).");
  assert.equal(result?.isError, undefined);
  assert.equal(
    readFileSync(file, "utf8"),
    "(deftest a-test []\n  (is (= 1 1)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0))))\n",
  );
  assert.match(resultText(result?.content), /Auto-repair note/);
  assert.match(resultText(result?.content), /repaired/);
  // the repair stayed inside the region the edit changed, so nothing to flag
  assert.doesNotMatch(resultText(result?.content), /outside the lines your edit changed/);
});

test("edit: a repair that reaches outside the edited lines says so", async () => {
  const before = "(defn f []\n  (let [x 1]\n    (inc x)))\n\n(def g 1)\n";
  const edited = "(defn f []\n  (let [x 1\n    (inc x)))\n\n(def g 1)\n";
  // a legal fix: the bracket returns on the error line, and one unrelated line
  // is rewritten as well, within the guard window
  const repaired = "(defn f []\n  (let [x 1]\n    (inc x)))\n\n(def g 1) ; touched\n";
  const file = path.join(tmp, "wide.clj");
  writeFileSync(file, before, "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "wide.clj", edits: [{ oldText: "[x 1]", newText: "[x 1" }] });
  writeFileSync(file, edited, "utf8");
  mockRepair({ [edited]: { status: "repaired", text: repaired } });
  mockFormat();

  const result = await h.toolResult("edit", id, { path: "wide.clj" }, "Successfully replaced 1 block(s).");
  assert.equal(readFileSync(file, "utf8"), repaired);
  assert.match(resultText(result?.content), /outside the lines your edit changed/);
  assert.match(resultText(result?.content), /line\(s\) 5/);
});

test("write call: content whose repair would reach beyond the error is blocked", async () => {
  const h = harness(tmp);
  const content = "(deftest drift-test []\n(when true\n(is true)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  const blocked = await h.toolCall("write", nextID(), { path: "blocked.clj", content });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /were not auto-fixed/);
  assert.match(blocked.reason, /opened at line 5 is never closed/);
  assert.equal(existsSync(path.join(tmp, "blocked.clj")), false, "nothing was written");
});

test("edit: failed call does not repair or restore", async () => {
  const file = path.join(tmp, "c.clj");
  writeFileSync(file, "(def c 1)\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "c.clj", edits: [{ oldText: "x", newText: "y" }] });
  const repairs = mockRepair({});
  mockFormat();
  await h.toolResult("edit", id, { path: "c.clj" }, "n/a", true);
  assert.equal(repairs.length, 0);
  assert.equal(readFileSync(file, "utf8"), "(def c 1)\n");
});

test("edit: non-Clojure files are not tracked", async () => {
  writeFileSync(path.join(tmp, "d.py"), "x = 1\n", "utf8");
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "d.py", edits: [{ oldText: "1", newText: "2" }] });
  const repairs = mockRepair({});
  mockFormat();
  await h.toolResult("edit", id, { path: "d.py" }, "ok");
  assert.equal(repairs.length, 0);
});

test("edit: missing file is not tracked", async () => {
  const h = harness(tmp);
  const id = nextID();
  await h.toolCall("edit", id, { path: "ghost.clj", edits: [{ oldText: "", newText: "(def g 1)" }] });
  const repairs = mockRepair({});
  mockFormat();
  await h.toolResult("edit", id, { path: "ghost.clj" }, "ok");
  assert.equal(repairs.length, 0);
});

test("relative paths resolve against ctx.cwd, not the process cwd", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-cwd-"));
  const nested = path.join(dir, "sub");
  mkdirSync(nested);
  const file = path.join(nested, "e.clj");
  writeFileSync(file, "(def e 1)\n", "utf8");
  const h = harness(dir);
  const id = nextID();
  await h.toolCall("edit", id, { path: "sub/e.clj", edits: [{ oldText: "1", newText: "2" }] });
  mockRepair({});
  mockFormat((t) => t.replace("1", "2"));
  const result = await h.toolResult("edit", id, { path: "sub/e.clj" }, "ok");
  assert.equal(readFileSync(file, "utf8"), "(def e 2)\n");
  assert.match(resultText(result?.content), /Auto-repair note:/);
  assert.equal(existsSync(path.join(tmp, "sub", "e.clj")), false);
});

// ---------------------------------------------------------------------------
// clojure-nrepl-eval tool registration
// ---------------------------------------------------------------------------

test("setup: registers the clojure-nrepl-eval tool end-to-end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-tool-"));
  const server = new FakeNrepl();
  await server.listen();
  writeFileSync(path.join(dir, ".nrepl-port"), String(server.port));

  const h = harness(dir);
  const tool = h.tools.get("clojure-nrepl-eval");
  assert.ok(tool, "clojure-nrepl-eval is registered");

  const result = await tool.execute("call-eval", { code: "(+ 1 2 3)" }, h.ctx.signal, undefined, h.ctx);
  assert.match(resultText(result.content), /=> 6/);

  await h.shutdown();
  await waitFor(() => server.received.some((m) => m.op === "close"));
  await server.close();
});

test("setup: empty code is rejected before connecting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-tool-empty-"));
  const server = new FakeNrepl();
  await server.listen();

  const h = harness(dir);
  const tool = h.tools.get("clojure-nrepl-eval");
  await assert.rejects(
    () => tool.execute("call-empty", { code: "   " }, h.ctx.signal, undefined, h.ctx),
    (err: unknown) => err instanceof Error && /non-empty/.test(err.message),
  );
  assert.equal(server.received.length, 0);
  await server.close();
});

test("handleToolCall and handleToolResult are exported for direct use", async () => {
  assert.equal(typeof handleToolCall, "function");
  assert.equal(typeof handleToolResult, "function");
});
