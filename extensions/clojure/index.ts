/**
 * pi extension: automatic Clojure delimiter repair + nREPL evaluation.
 *
 * Delimiter repair runs in-process through the `parinfer` npm package
 * (`indentMode`, Parinfer's indent mode). Formatting runs `cljfmt` directly
 * when it is on PATH (`cljfmt fix -`, stdin to stdout) and is skipped
 * otherwise. The `clojure-nrepl-eval` tool evaluates code against the
 * project's nREPL server through an in-process bencode client (persistent
 * session per host:port). No babashka, no external repair tool.
 *
 * Behavior:
 * - write: content is repaired (and formatted, if cljfmt is available) before
 *          it hits disk by mutating the tool input; the call is blocked with an
 *          error when the content has delimiter errors the repair will not
 *          touch, or cannot be fixed at all. When the content was modified, the
 *          tool result carries a change note with the current on-disk content so
 *          the model does not act on a stale view of the file.
 * - edit:  the file is backed up in memory before the edit; after the edit the
 *          on-disk file is repaired and formatted, and the backup is restored
 *          when the edit left delimiter errors the repair declines or cannot
 *          fix. When the file was modified, the tool result carries a change
 *          note (current content for small files, a line diff for large ones),
 *          calling out any delimiter the repair moved outside the lines the edit
 *          changed.
 *
 * Balanced code is never touched: `scanClojure` gates the repair engine, and it
 * also says where the delimiters are wrong, which is what makes a declined repair
 * actionable. A repair proposal is accepted only while it rewrites a couple of
 * lines next to that error (`repairSurgically`): parinfer's indent mode otherwise
 * moves real delimiters to match indentation elsewhere in the file, and the
 * mangled result still parses, so nothing downstream would notice. When repair or
 * formatting fails for any other reason the operation proceeds un-repaired (fail
 * open). Shell writes are not repaired: only the `write` and `edit` tools run
 * through this hook.
 */

import path from "node:path";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import {
  defineTool,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  changedLinesBetween,
  formatContent,
  isClojureFile,
  readTextFile,
  repairSurgically,
  scanClojure,
} from "./repair.ts";
import { buildChangeNote, type ChangeReason } from "./notes.ts";
import { closeAllTargets, evalClojure, NREPL_DEFAULT_TIMEOUT_MS } from "./nrepl.ts";

// ============================================================================
// State keyed by tool call id
// ============================================================================

interface CallState {
  /** Set by the write tool: the content the model asked for, before repair. */
  write?: { path: string; original: string; reasons: ChangeReason[] };
  /** Set by the edit tool: the on-disk content before the edit ran. */
  edit?: { path: string; backup: string };
}

// Stale entries left behind when a call is blocked by another extension are
// bounded by MAX_CALL_STATES; the oldest are dropped first.
const MAX_CALL_STATES = 200;
const callStates = new Map<string, CallState>();

function stashState(callID: string, state: CallState): void {
  if (callStates.size >= MAX_CALL_STATES) {
    const oldest = callStates.keys().next();
    if (!oldest.done) callStates.delete(oldest.value);
  }
  callStates.set(callID, state);
}

function takeState(callID: string): CallState | undefined {
  const state = callStates.get(callID);
  if (state) callStates.delete(callID);
  return state;
}

// ============================================================================
// Repair + format one body of Clojure text
// ============================================================================

type ProcessedContent =
  | { status: "ok"; text: string; reasons: ChangeReason[]; rewrote: number[] }
  | { status: "rejected"; kind: "unfixable" | "declined" | "unsafe-format"; message: string };

/**
 * Repairs `content` (the content of `label`) and formats it when cljfmt is
 * available; `reasons` reports which step actually changed the content. A repair
 * the guard declines counts as a rejection: the author's own text is kept (via
 * `restore`, when provided) rather than a proposal that moved delimiters away
 * from the error. `anchors` are the lines the caller is responsible for, and
 * justify a repair near them.
 */
async function processContent(
  label: string,
  content: string,
  opts: { anchors?: number[]; restore?: () => void } = {},
): Promise<ProcessedContent> {
  const reasons: ChangeReason[] = [];
  let out = content;
  let rewrote: number[] = [];

  const repair = await repairSurgically(content, { anchors: opts.anchors });
  switch (repair.status) {
    case "clean":
      break;
    case "repaired":
      reasons.push("repaired");
      out = repair.text;
      rewrote = repair.rewrote;
      break;
    case "error":
      console.warn(`[pi-clojure] repair unavailable for ${label}: ${repair.message}`);
      break;
    case "declined":
      opts.restore?.();
      return { status: "rejected", kind: "declined", message: repair.message };
    case "unfixable":
      opts.restore?.();
      return { status: "rejected", kind: "unfixable", message: repair.message };
  }

  const formatted = await formatContent(out);
  if (formatted !== out) reasons.push("formatted");
  // cljfmt only ever moves whitespace: output that reads worse than the input
  // never reaches the file
  if (scanClojure(formatted).length > 0 && scanClojure(out).length === 0) {
    opts.restore?.();
    return { status: "rejected", kind: "unsafe-format", message: "cljfmt output has delimiter errors" };
  }
  return { status: "ok", text: formatted, reasons, rewrote };
}

// ============================================================================
// tool_call: repair the write input, back up the edit target
// ============================================================================

export async function handleToolCall(
  event: ToolCallEvent,
  ctx: Pick<ExtensionContext, "cwd">,
): Promise<{ block?: boolean; reason?: string } | void> {
  if (event.toolName === "write") {
    const input = event.input as { path?: unknown; content?: unknown } | undefined;
    if (typeof input?.path !== "string" || typeof input.content !== "string") return;
    const abs = path.resolve(ctx.cwd, input.path);
    if (!isClojureFile(abs, input.content)) return;
    const outcome = await processContent(input.path, input.content);
    if (outcome.status === "rejected") {
      return {
        block: true,
        reason: `Clojure delimiter errors in ${input.path} ${rejectionWhy(outcome)}. Fix the delimiters and write again.`,
      };
    }
    if (outcome.text !== input.content) {
      // the tool_result handler attaches a change note to the tool result
      stashState(event.toolCallId, { write: { path: abs, original: input.content, reasons: outcome.reasons } });
      input.content = outcome.text; // in-place: pi skips re-validation
    }
    return;
  }

  if (event.toolName === "edit") {
    const input = event.input as { path?: unknown } | undefined;
    if (typeof input?.path !== "string") return;
    const abs = path.resolve(ctx.cwd, input.path);
    const content = readTextFile(abs);
    if (content === undefined || !isClojureFile(abs, content)) return;
    stashState(event.toolCallId, { edit: { path: abs, backup: content } });
    return;
  }
}

// ============================================================================
// tool_result: report what the repair changed, revert what it cannot fix
// ============================================================================

export async function handleToolResult(
  event: ToolResultEvent,
  _ctx: Pick<ExtensionContext, "cwd">,
): Promise<ToolResultEventResult | void> {
  if (event.toolName !== "write" && event.toolName !== "edit") return;
  const state = takeState(event.toolCallId);
  if (!state) return;
  if (event.isError) return; // failed call: nothing was applied

  // write: the repaired content is already on disk; tell the model what it is
  const written = state.write;
  if (written) {
    const onDisk = readTextFile(written.path);
    if (onDisk === undefined || onDisk === written.original) return;
    const note = buildChangeNote(written.path, written.original, onDisk, written.reasons);
    return { content: [...event.content, { type: "text", text: note }] };
  }

  // edit: repair what the edit produced, restore the backup when unfixable
  const edit = state.edit;
  if (!edit) return;
  const restore = () => writeFileSync(edit.path, edit.backup, "utf8");
  return withFileMutationQueue(edit.path, async () => {
    const before = readTextFile(edit.path);
    if (before === undefined) return;
    // the lines the edit itself is answerable for: a repair near them is the
    // repair doing its job, a repair anywhere else is rewriting unrelated code
    const anchors = changedLinesBetween(edit.backup, before);
    const outcome = await processContent(edit.path, before, { anchors, restore });
    if (outcome.status === "rejected") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Edit to ${edit.path} was reverted: delimiter errors ${rejectionWhy(outcome)}. The file is back to its pre-edit content; fix the delimiters and retry the edit.`,
          },
        ],
        isError: true,
      };
    }
    if (outcome.text === before) return; // balanced and already formatted
    writeFileSync(edit.path, outcome.text, "utf8");
    const outside = outsideRepairLines(outcome.rewrote, anchors);
    const note = buildChangeNote(edit.path, before, outcome.text, outcome.reasons, outside);
    return { content: [...event.content, { type: "text", text: note }] };
  });
}

/** Rewritten lines the edit did not ask for, phrased for the change note. */
function outsideRepairLines(rewrote: number[], region: number[]): string[] {
  const outside = rewrote.filter((line) => !region.some((changed) => Math.abs(changed - line) <= 1));
  if (outside.length === 0) return [];
  return [`The repair moved delimiters on line(s) ${outside.join(", ")}, outside the lines your edit changed.`];
}

/** Why content was refused, phrased for both the write and edit messages. */
function rejectionWhy(outcome: { kind: "unfixable" | "declined" | "unsafe-format"; message: string }): string {
  switch (outcome.kind) {
    case "unfixable":
      return `could not be auto-fixed (${outcome.message})`;
    case "declined":
      return `were not auto-fixed: the repair would have moved delimiters outside what you wrote (${outcome.message})`;
    case "unsafe-format":
      return `would have been left unbalanced by cljfmt (${outcome.message})`;
  }
}

// ============================================================================
// clojure-nrepl-eval tool
// ============================================================================

const nreplEvalTool = defineTool({
  name: "clojure-nrepl-eval",
  label: "clojure-nrepl-eval",
  description:
    "Evaluate Clojure code against the project's nREPL server (Clojure, babashka, shadow-cljs, ...). " +
    "Session state persists between calls, so a namespace required in one call is available in the next. " +
    "Delimiter errors in the code are repaired automatically before evaluation; unfixable code is rejected " +
    "without being evaluated. When port is omitted, the port is read from .nrepl-port (or " +
    ".shadow-cljs/.nrepl-port) in the working directory. If the connection fails, ask the user to start an " +
    "nREPL server and pass the port explicitly.",
  promptSnippet: "Evaluate Clojure code against the project's nREPL server (persistent session)",
  promptGuidelines: [
    "Use clojure-nrepl-eval to check Clojure code against the running nREPL server instead of guessing at results",
    "Omit port to read .nrepl-port from the working directory; pass it explicitly when the server is elsewhere",
  ],
  parameters: Type.Object({
    code: Type.String({ description: "Clojure code to evaluate (one or more complete forms)" }),
    port: Type.Optional(Type.Number({ description: "nREPL port; omit to read .nrepl-port from the working directory" })),
    host: Type.Optional(Type.String({ description: "nREPL host (default: 127.0.0.1)" })),
    timeoutMs: Type.Optional(
      Type.Number({ description: `Evaluation timeout in milliseconds (default: ${NREPL_DEFAULT_TIMEOUT_MS})` }),
    ),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (!params.code.trim()) {
      throw new Error("clojure-nrepl-eval requires a non-empty `code` string.");
    }
    const content = await evalClojure({
      code: params.code,
      dir: ctx.cwd,
      port: params.port,
      host: params.host,
      timeoutMs: params.timeoutMs,
      signal: signal ?? ctx.signal,
    });
    return { content: [{ type: "text", text: content }], details: undefined };
  },
});

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => handleToolResult(event, ctx));
  pi.registerTool(nreplEvalTool);
  // nREPL sockets are opened lazily by the tool, never while loading.
  pi.on("session_shutdown", () => closeAllTargets());
}
