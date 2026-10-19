import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import net from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  evalClojure,
  findNreplPort,
  readBencode,
  writeBencode,
  _internals,
} from "../extensions/clojure/nrepl.ts";
import { FakeNrepl, waitFor } from "./fake-nrepl.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "piclj-nrepl-"));

const openServers: FakeNrepl[] = [];
function startServer() {
  const server = new FakeNrepl();
  openServers.push(server);
  return server;
}

async function rejects(fn: () => Promise<unknown>, match: RegExp) {
  await assert.rejects(fn, (err: unknown) => err instanceof Error && match.test(err.message));
}

afterEach(async () => {
  _internals.resetNreplPool();
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

// ---------------------------------------------------------------------------
// bencode codec
// ---------------------------------------------------------------------------

test("writeBencode: flat map with lexicographically sorted keys", () => {
  const buf = writeBencode({ op: "eval", id: "1", code: "(def a 1)" });
  assert.equal(buf.toString("utf8"), "d4:code9:(def a 1)2:id1:12:op4:evale");
});

test("bencode round-trip: nested maps, lists, integers, multi-byte strings", () => {
  const value = {
    versions: { clojure: { "version-string": "1.11" } },
    ops: ["clone", "eval"],
    count: 42,
    name: "héllo",
  };
  const parsed = readBencode(writeBencode(value), 0);
  assert.deepEqual(parsed?.[0], value);
});

test("readBencode: incomplete buffers return null", () => {
  const buf = writeBencode({ op: "eval", code: "(def a 1)" });
  for (let n = 1; n < buf.length; n++) {
    assert.equal(readBencode(buf.subarray(0, n), 0), null, `prefix of ${n} bytes`);
  }
});

test("bencode: string lengths count bytes, not characters", () => {
  assert.equal(writeBencode("héllo").subarray(0, 2).toString("utf8"), "6:");
});

// ---------------------------------------------------------------------------
// evalClojure
// ---------------------------------------------------------------------------

test("evalClojure: returns the value and namespace", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "(+ 1 2 3)", dir: tmp, port: server.port });
  assert.match(out, /=> 6/);
  assert.match(out, /;; namespace: user/);
});

test("evalClojure: state persists across calls in one session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def counter 10)", dir: tmp, port: server.port });
  const out = await evalClojure({ code: "counter", dir: tmp, port: server.port });
  assert.match(out, /=> 10/);
  assert.equal(server.received.filter((m) => m.op === "clone").length, 1);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].session, evals[1].session);
});

test("evalClojure: code is repaired before evaluation", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "(+ a b", dir: tmp, port: server.port });
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].code, "(+ a b)");
  assert.match(out, /=> nil/);
});

test("evalClojure: unfixable code is rejected without connecting", async () => {
  const server = startServer();
  await server.listen();
  await rejects(() => evalClojure({ code: '#("foo', dir: tmp, port: server.port }), /delimiter errors/);
  assert.equal(server.received.length, 0);
});

test("evalClojure: stdout arrives as out before the value", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: '(println "hello")', dir: tmp, port: server.port });
  assert.match(out, /hello/);
  assert.match(out, /=> nil/);
});

test("evalClojure: exceptions surface with a truncated trace", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "boom", dir: tmp, port: server.port });
  assert.match(out, /Exception: java\.lang\.Exception/);
  assert.match(out, /boom at repl1:1/);
  assert.match(out, /\.\.\. \(truncated\)/);
});

test("evalClojure: port discovered from .nrepl-port", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-port-"));
  const server = startServer();
  await server.listen();
  writeFileSync(path.join(dir, ".nrepl-port"), `${server.port}\n`);
  const out = await evalClojure({ code: "(+ 1 1)", dir });
  assert.match(out, /=> 2/);
});

test("evalClojure: port discovered from .shadow-cljs/.nrepl-port", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-shadow-"));
  mkdirSync(path.join(dir, ".shadow-cljs"));
  const server = startServer();
  await server.listen();
  writeFileSync(path.join(dir, ".shadow-cljs", ".nrepl-port"), String(server.port));
  const out = await evalClojure({ code: "(+ 1 1)", dir });
  assert.match(out, /=> 2/);
});

test("findNreplPort: missing or invalid files yield null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-none-"));
  assert.equal(findNreplPort(dir), null);
  writeFileSync(path.join(dir, ".nrepl-port"), "not-a-port\n");
  assert.equal(findNreplPort(dir), null);
});

test("evalClojure: no port and no port file is an error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piclj-noport-"));
  await rejects(() => evalClojure({ code: "1", dir }), /\.nrepl-port/);
});

test("evalClojure: connection refused is an error", async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await rejects(() => evalClojure({ code: "1", dir: tmp, port }), /Could not connect/);
});

test("evalClojure: timeout interrupts the evaluation", async () => {
  const server = startServer();
  await server.listen();
  server.ignoreEval = true;
  await rejects(
    () => evalClojure({ code: "(Thread/sleep 10000)", dir: tmp, port: server.port, timeoutMs: 100 }),
    /timed out/,
  );
  await waitFor(() => server.received.some((m) => m.op === "interrupt"));
});

test("evalClojure: reconnects and keeps the session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def x 42)", dir: tmp, port: server.port });
  _internals.dropNreplConnection("127.0.0.1", server.port);
  const out = await evalClojure({ code: "x", dir: tmp, port: server.port });
  assert.match(out, /=> 42/);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].session, evals[1].session);
});

test("evalClojure: server restart creates a fresh session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def x 1)", dir: tmp, port: server.port });
  server.dropSessions();
  _internals.dropNreplConnection("127.0.0.1", server.port);
  const out = await evalClojure({ code: "(+ 1 2 3)", dir: tmp, port: server.port });
  assert.match(out, /=> 6/);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.notEqual(evals[0].session, evals[1].session);
});
