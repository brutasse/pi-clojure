import net from "node:net";
import { readBencode, writeBencode } from "../extensions/clojure/nrepl.ts";

/** An nREPL server that speaks the same bencode wire format as the client. */
export class FakeNrepl {
  server: net.Server | null = null;
  port = 0;
  sessions = new Map<string, Map<string, string>>(); // session id -> vars
  private sessionSeq = 0; // monotonic: ids stay unique even after dropSessions
  received: Record<string, unknown>[] = [];
  ignoreEval = false; // for timeout tests
  connectionCount = 0;

  async listen() {
    this.server = net.createServer((sock) => {
      this.connectionCount++;
      sock.on("error", () => {}); // ignore ECONNRESET/EPIPE from client disconnects
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = readBencode(buf, 0);
          if (parsed === null) return;
          const [value, next] = parsed;
          buf = buf.subarray(next);
          this.handle(sock, value as Record<string, unknown>);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  private send(sock: net.Socket, msg: Record<string, unknown>) {
    sock.write(writeBencode(msg));
  }

  private handle(sock: net.Socket, msg: Record<string, unknown>) {
    this.received.push(msg);
    if (this.ignoreEval && msg.op === "eval") return;
    switch (msg.op) {
      case "clone": {
        const session = `sess-${++this.sessionSeq}`;
        this.sessions.set(session, new Map());
        this.send(sock, { "new-session": session, id: msg.id, status: ["done"] });
        break;
      }
      case "ls-sessions":
        this.send(sock, { sessions: [...this.sessions.keys()], id: msg.id, status: ["done"] });
        break;
      case "close":
        this.sessions.delete(String(msg.session));
        this.send(sock, { session: msg.session, id: msg.id, status: ["done"] });
        break;
      case "interrupt":
        this.send(sock, { status: ["interrupted", "done"], id: msg.id });
        break;
      case "eval":
        this.evalReply(sock, msg);
        break;
    }
  }

  private evalReply(sock: net.Socket, msg: Record<string, unknown>) {
    const session = typeof msg.session === "string" ? msg.session : undefined;
    const state = session ? this.sessions.get(session) : undefined;
    const code = String(msg.code);
    const base = { id: msg.id, ...(session ? { session } : {}) };
    if (code.includes("println")) {
      this.send(sock, { ...base, out: "hello\n", status: [] });
      this.send(sock, { ...base, value: "nil", ns: "user", status: ["done"] });
    } else if (code === "boom") {
      this.send(sock, {
        ...base,
        ex: "java.lang.Exception",
        err: "boom at repl1:1\n",
        trace: "user/eval (fake.clj:1)\n".repeat(200),
        ns: "user",
        status: ["done"],
      });
    } else if (code === "(+ 1 2 3)") {
      this.send(sock, { ...base, value: "6", ns: "user", status: ["done"] });
    } else if (code === "(+ 1 1)") {
      this.send(sock, { ...base, value: "2", ns: "user", status: ["done"] });
    } else if (code.startsWith("(def ")) {
      const name = code.match(/\(def (\w+)/)?.[1] ?? "";
      const value = code.match(/\(def \w+ (.+?)\)$/)?.[1] ?? "nil";
      state?.set(name, value);
      this.send(sock, { ...base, value, ns: "user", status: ["done"] });
    } else if (/^\w+$/.test(code) && state?.has(code)) {
      this.send(sock, { ...base, value: state.get(code)!, ns: "user", status: ["done"] });
    } else {
      this.send(sock, { ...base, value: "nil", ns: "user", status: ["done"] });
    }
  }

  dropSessions() {
    this.sessions.clear(); // simulate an nREPL server restart
  }

  async close() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/** Poll until `cond` returns truthy (socket writes are async). */
export async function waitFor(cond: () => boolean, ms = 1_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
