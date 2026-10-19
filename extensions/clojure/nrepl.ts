/**
 * nREPL client (bencode wire protocol, in-process) and the evaluation backend
 * behind the `clojure-nrepl-eval` tool.
 *
 * nREPL speaks self-delimiting bencode messages over TCP (no length framing).
 * This client implements the ops the extension needs: clone (persistent
 * session), ls-sessions (session validation), eval, interrupt (timeout), and
 * close (teardown). Responses are matched by the request's "id"; a request
 * completes when a response's "status" list contains "done".
 *
 * The same delimiter repair gate runs on eval code before evaluation, so
 * unfixable code is rejected instead of being sent to the server.
 */

import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { repairSurgically } from "./repair.ts";

const NREPL_CONNECT_TIMEOUT_MS = 2_000;
const NREPL_SESSION_TIMEOUT_MS = 5_000;
export const NREPL_DEFAULT_TIMEOUT_MS = 120_000;
const NREPL_TRACE_LIMIT = 4_000;

// ============================================================================
// Bencode
// ============================================================================

export type BencodeValue = string | number | BencodeValue[] | { [key: string]: BencodeValue };

// Bencode map keys must be sorted lexicographically by byte value.
function sortEntries(entries: [string, unknown][]): [string, unknown][] {
  return entries.sort((a, b) => {
    const ka = Buffer.from(a[0], "utf8");
    const kb = Buffer.from(b[0], "utf8");
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return ka.length - kb.length;
  });
}

export function writeBencode(value: unknown): Buffer {
  if (typeof value === "string") {
    return Buffer.concat([
      Buffer.from(`${Buffer.byteLength(value, "utf8")}:`, "utf8"),
      Buffer.from(value, "utf8"),
    ]);
  }
  if (typeof value === "number") {
    return Buffer.from(`i${Math.trunc(value)}e`, "utf8");
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from("l", "utf8"),
      Buffer.concat(value.map((item) => writeBencode(item))),
      Buffer.from("e", "utf8"),
    ]);
  }
  if (value !== null && typeof value === "object") {
    const parts: Buffer[] = [Buffer.from("d", "utf8")];
    for (const [key, item] of sortEntries(Object.entries(value as Record<string, unknown>))) {
      parts.push(writeBencode(key), writeBencode(item));
    }
    parts.push(Buffer.from("e", "utf8"));
    return Buffer.concat(parts);
  }
  throw new Error(`nrepl: cannot bencode value of type ${typeof value}`);
}

// Parses one bencode value starting at `pos`. Returns the value and the
// position just past it, or null when the buffer holds an incomplete value.
export function readBencode(buf: Buffer, pos: number): [BencodeValue, number] | null {
  const c = buf[pos];
  if (c === undefined) return null; // empty buffer: need more data
  if (c === 0x64) {
    // map
    const out: Record<string, BencodeValue> = {};
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) return null;
      if (buf[p] === 0x65) return [out, p + 1]; // 'e'
      const key = readBencode(buf, p);
      if (key === null) return null;
      if (typeof key[0] !== "string") throw new Error("nrepl: bencode map key must be a string");
      const item = readBencode(buf, key[1]);
      if (item === null) return null;
      out[key[0]] = item[0];
      p = item[1];
    }
  }
  if (c === 0x6c) {
    // list
    const out: BencodeValue[] = [];
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) return null;
      if (buf[p] === 0x65) return [out, p + 1]; // 'e'
      const item = readBencode(buf, p);
      if (item === null) return null;
      out.push(item[0]);
      p = item[1];
    }
  }
  if (c === 0x69) {
    // integer: i<digits>e (the terminator is the first non-digit byte)
    let end = pos + 1;
    while (end < buf.length && buf[end] >= 0x30 && buf[end] <= 0x39) end++;
    if (end >= buf.length) return null;
    if (buf[end] !== 0x65) throw new Error("nrepl: malformed bencode integer");
    return [Number.parseInt(buf.subarray(pos + 1, end).toString("utf8"), 10), end + 1];
  }
  if (c >= 0x30 && c <= 0x39) {
    // string: <decimal byte length>:<bytes>
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) return null;
    const len = Number.parseInt(buf.subarray(pos, colon).toString("utf8"), 10);
    const start = colon + 1;
    if (start + len > buf.length) return null;
    return [buf.subarray(start, start + len).toString("utf8"), start + len];
  }
  throw new Error(`nrepl: unexpected bencode byte 0x${c.toString(16)}`);
}

// ============================================================================
// Socket
// ============================================================================

interface PendingRequest {
  msgs: Record<string, BencodeValue>[];
  resolve: (msgs: Record<string, BencodeValue>[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

class NreplSocket {
  readonly host: string;
  readonly port: number;
  closed = false;
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private seq = 0;

  private constructor(socket: net.Socket, host: string, port: number) {
    this.socket = socket;
    this.host = host;
    this.port = port;
    socket.on("data", (chunk) => this.onData(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
    socket.on("error", (err) => this.failAll(new Error(`nREPL connection to ${host}:${port} was lost: ${err.message}`)));
    socket.on("close", () => {
      this.closed = true;
      this.failAll(new Error(`nREPL connection to ${host}:${port} was lost`));
    });
  }

  static async connect(host: string, port: number, timeoutMs: number): Promise<NreplSocket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(err.code === "ECONNREFUSED" ? "connection refused" : err.message));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(new NreplSocket(socket, host, port));
      });
    });
  }

  request(msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, BencodeValue>[]> {
    const id = String(++this.seq);
    const entry: PendingRequest = {
      msgs: [],
      resolve: () => undefined,
      reject: () => undefined,
      timer: undefined as unknown as NodeJS.Timeout,
    };
    this.pending.set(id, entry);
    return new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => entry.reject(new Error(`nREPL request timed out after ${timeoutMs}ms`)), timeoutMs);
      if (signal) {
        entry.abortSignal = signal;
        entry.onAbort = () => entry.reject(new Error("nREPL request was cancelled"));
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      try {
        this.socket.write(writeBencode({ ...msg, id }));
      } catch (err) {
        entry.reject(new Error(`nREPL write failed: ${String(err)}`));
      }
    });
  }

  // Fire-and-forget message (e.g. interrupt/close); its response is ignored.
  notify(msg: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.write(writeBencode({ ...msg, id: String(++this.seq) }));
    } catch {
      // best effort
    }
  }

  close(): void {
    if (this.closed) return;
    // Flush any pending write (e.g. the close op sent on teardown) before
    // tearing the socket down.
    this.socket.end();
    this.socket.destroySoon();
  }

  private settle(id: string, err?: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.abortSignal && entry.onAbort) entry.abortSignal.removeEventListener("abort", entry.onAbort);
    if (err) entry.reject(err);
    else entry.resolve(entry.msgs);
  }

  private failAll(err: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, err);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      let parsed: [BencodeValue, number] | null;
      try {
        parsed = readBencode(this.buf, 0);
      } catch (err) {
        this.failAll(new Error(`nREPL: malformed bencode message: ${String(err)}`));
        return;
      }
      if (parsed === null) return; // incomplete message: wait for more data
      const [value, next] = parsed;
      this.buf = this.buf.subarray(next);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        this.route(value as Record<string, BencodeValue>);
      }
    }
  }

  private route(msg: Record<string, BencodeValue>): void {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (!id || !this.pending.has(id)) return;
    this.pending.get(id)!.msgs.push(msg);
    // bencode has no booleans: the completion marker is the "done" entry
    // in the response's "status" list (per the nREPL protocol spec).
    const status = msg.status;
    if (Array.isArray(status) && status.includes("done")) this.settle(id);
  }
}

// ============================================================================
// Session pool (one persistent entry per host:port)
// ============================================================================

// One persistent entry per host:port: the socket plus the nREPL session id
// (state persists between evaluations, as in clj-nrepl-eval).
interface Target {
  host: string;
  port: number;
  socket: NreplSocket | null;
  sessionID: string | null;
  validated: boolean; // sessionID verified against ls-sessions on the current socket
}

const targets = new Map<string, Target>();

async function withNrepl(
  host: string,
  port: number,
  fn: (target: Target) => Promise<Record<string, BencodeValue>[]>,
): Promise<Record<string, BencodeValue>[]> {
  const key = `${host}:${port}`;
  let target = targets.get(key);
  if (!target) {
    target = { host, port, socket: null, sessionID: null, validated: false };
    targets.set(key, target);
  }
  if (!target.socket || target.socket.closed) {
    target.socket = await NreplSocket.connect(host, port, NREPL_CONNECT_TIMEOUT_MS);
    target.validated = false;
  }
  const socket = target.socket;
  // Sessions live on the server: validate the stored session whenever the
  // socket was (re)established, and create it on first use (clone).
  if (target.sessionID !== null && !target.validated) {
    const msgs = await socket.request({ op: "ls-sessions" }, NREPL_SESSION_TIMEOUT_MS);
    const listed = msgs.find((m) => Array.isArray(m.sessions));
    if (listed && !(listed.sessions as BencodeValue[]).includes(target.sessionID)) {
      target.sessionID = null; // server restarted: fall through to clone
    }
    target.validated = true;
  }
  if (target.sessionID === null) {
    const msgs = await socket.request({ op: "clone" }, NREPL_SESSION_TIMEOUT_MS);
    const created = msgs.find((m) => typeof m["new-session"] === "string");
    target.sessionID = created ? (created["new-session"] as string) : null;
    // Servers without clone get sessionless (ephemeral, stateless) evals.
  }
  return fn(target);
}

export function closeAllTargets(): void {
  for (const target of targets.values()) {
    if (target.socket && !target.socket.closed) {
      if (target.sessionID) target.socket.notify({ op: "close", session: target.sessionID });
      target.socket.close();
    }
    target.socket = null;
  }
}

function interruptIfPossible(host: string, port: number): void {
  targets.get(`${host}:${port}`)?.socket?.notify({ op: "interrupt" });
}

// Test seam: teardown between cases and forced reconnects.
export const _internals = {
  resetNreplPool() {
    closeAllTargets();
    targets.clear();
  },
  dropNreplConnection(host: string, port: number) {
    const target = targets.get(`${host}:${port}`);
    target?.socket?.close();
    if (target) target.socket = null;
  },
};

// ============================================================================
// Evaluation
// ============================================================================

export function findNreplPort(dir: string): number | null {
  for (const file of [path.join(dir, ".nrepl-port"), path.join(dir, ".shadow-cljs", ".nrepl-port")]) {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return null;
}

interface MergedEval {
  values: string[];
  out: string;
  err: string;
  ns?: string;
  ex?: string;
  trace?: string;
}

function mergeEvalMessages(msgs: Record<string, BencodeValue>[]): MergedEval {
  const values: string[] = [];
  let out = "";
  let err = "";
  let ns: string | undefined;
  let ex: string | undefined;
  let trace: string | undefined;
  for (const m of msgs) {
    if (typeof m.value === "string") values.push(m.value);
    else if (Array.isArray(m.value)) values.push(...m.value.filter((v): v is string => typeof v === "string"));
    if (typeof m.out === "string") out += m.out;
    else if (Array.isArray(m.out)) out += m.out.filter((v): v is string => typeof v === "string").join("");
    if (typeof m.err === "string") err += m.err;
    else if (Array.isArray(m.err)) err += m.err.filter((v): v is string => typeof v === "string").join("");
    if (typeof m.ns === "string") ns = m.ns;
    if (typeof m.ex === "string") ex = m.ex;
    if (typeof m.trace === "string") trace = m.trace;
  }
  return { values, out, err, ns, ex, trace };
}

function formatEvalResult(m: MergedEval, host: string, port: number): string {
  const parts: string[] = [];
  if (m.out.trim()) parts.push(m.out.trimEnd());
  if (m.ex) {
    parts.push(`Exception: ${m.ex}`);
    if (m.err.trim()) parts.push(m.err.trimEnd());
    if (m.trace) {
      parts.push(m.trace.length > NREPL_TRACE_LIMIT ? `${m.trace.slice(0, NREPL_TRACE_LIMIT)}\n... (truncated)` : m.trace.trimEnd());
    }
  } else if (m.err.trim()) {
    parts.push(m.err.trimEnd());
  }
  for (const v of m.values) parts.push(`=> ${v}`);
  if (m.ns) parts.push(`;; namespace: ${m.ns}`);
  if (parts.length === 0) return `Evaluation on ${host}:${port} completed with no output.`;
  return parts.join("\n");
}

export interface EvalOptions {
  code: string;
  dir: string; // working directory for .nrepl-port discovery
  port?: number;
  host?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function evalClojure(opts: EvalOptions): Promise<string> {
  let code = opts.code;
  const repair = await repairSurgically(code);
  if (repair.status === "declined" || repair.status === "unfixable") {
    throw new Error(
      `Clojure delimiter errors in the eval code were not auto-fixed (${repair.message}). Fix the delimiters and try again.`,
    );
  }
  if (repair.status === "error") {
    console.warn(`[pi-clojure] repair unavailable for eval code: ${repair.message}`);
  } else if (repair.status === "repaired") {
    code = repair.text;
  }

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? findNreplPort(opts.dir);
  if (port === null) {
    throw new Error(
      `No nREPL server port found: pass a port explicitly or write the port to .nrepl-port in ${opts.dir} (also checked .shadow-cljs/.nrepl-port).`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? NREPL_DEFAULT_TIMEOUT_MS;

  try {
    const msgs = await withNrepl(host, port, (target) =>
      target.socket!.request(
        target.sessionID ? { op: "eval", code, session: target.sessionID } : { op: "eval", code },
        timeoutMs,
        opts.signal,
      ),
    );
    return formatEvalResult(mergeEvalMessages(msgs), host, port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("nREPL request timed out")) {
      interruptIfPossible(host, port);
      throw new Error(
        `Evaluation timed out after ${timeoutMs}ms and was interrupted. Try a smaller evaluation or a larger timeoutMs.`,
      );
    }
    if (message === "nREPL request was cancelled") {
      interruptIfPossible(host, port);
      throw new Error("Evaluation cancelled.");
    }
    if (message === "connection refused" || message.startsWith("connect timed out")) {
      throw new Error(
        `Could not connect to the nREPL server at ${host}:${port} (${message}). Start an nREPL server for the project and try again; pass the port explicitly when it is not in .nrepl-port.`,
      );
    }
    throw new Error(`nREPL evaluation at ${host}:${port} did not complete: ${message}. Try the evaluation again.`);
  }
}
