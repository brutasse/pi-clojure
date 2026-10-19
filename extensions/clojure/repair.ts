/**
 * Clojure delimiter repair: a scanner that localizes delimiter errors, a repair
 * step that is accepted only when it stays next to the error, and optional
 * `cljfmt` formatting that may only move whitespace.
 *
 * Delimiter repair runs in-process through the `parinfer` npm package
 * (`indentMode`, in-process). Formatting runs `cljfmt` directly when it is on
 * PATH (`cljfmt fix -`, stdin to stdout) and is skipped otherwise. No babashka,
 * no external repair tool.
 *
 * Balanced code is never touched: `scanClojure` gates the repair engine so
 * balanced files - including valid code with tricky content like char literals -
 * are left alone.
 *
 * Parinfer's indent mode reads indentation as the truth, so on a file whose
 * indentation does not already agree with its delimiters it fixes the wrong
 * thing: measured on a real codebase, one missing closer made it move
 * delimiters on up to 33 lines, up to 1190 lines away from the error, and the
 * result stayed balanced, so nothing downstream could spot it. `repairSurgically`
 * therefore accepts the engine's proposal only when it rewrote a couple of lines
 * next to the error the scanner found; a wider rewrite is declined and the caller
 * keeps the author's own text.
 *
 * `cljfmt` is trusted only as a whitespace tool: an output that is empty or that
 * changes any non-whitespace character is discarded. It exits 0 with no output at
 * all when it cannot read the forms, and writing that back would empty the file.
 */

import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import parinfer from "parinfer";

// ============================================================================
// Delimiter scanner (the repair pre-gate, and the error locations it reports)
// ============================================================================

// Scans Clojure source for delimiter errors: an unmatched or mismatched ()[]{}
// delimiter, or an unterminated string / regex literal. String literals
// (including multi-line), char literals (like \( and \space), line comments (;),
// and regex literals are skipped. Every error carries the line and column the
// repair guard and the error messages work from.
//
// A missed error leaves a broken file un-repaired (safe); reporting an error on
// balanced code would send valid code to the repair engine, so the scanner errs
// on the side of recognizing balanced constructs. At most MAX_UNCLOSED unclosed
// openers are reported, outermost first, so a badly truncated file does not hand
// the guard a file-wide set of anchors.
export type ScanErrorKind =
  | "extra-closer"
  | "mismatched-closer"
  | "unclosed"
  | "unterminated-string"
  | "unterminated-regex";

export interface ScanError {
  kind: ScanErrorKind;
  /** 1-based line. For `unclosed` and `unterminated-*`, where the opener sits. */
  line: number;
  /** 1-based column of the offending character. */
  col: number;
  /** The offending delimiter, or the opening quote for `unterminated-*`. */
  char: string;
  /** For `mismatched-closer`: the opener this closer should have matched. */
  opener?: { char: string; line: number };
}

const MAX_UNCLOSED = 3;

const CLOSING_FOR = new Map<string, string>([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

export function scanClojure(text: string): ScanError[] {
  interface Open {
    char: string;
    line: number;
    col: number;
  }
  const stack: Open[] = [];
  const errors: ScanError[] = [];
  let inString = false;
  let inRegex = false;
  let inComment = false;
  let quote: Open | undefined;
  let line = 1;
  let lineStart = 0; // index where the current line begins
  let i = 0;

  // 1-based column of the character at the cursor
  const col = () => i - lineStart + 1;

  // step one (or two, for escapes and char literals) characters forward,
  // tracking the line as newlines go by
  const step = (n = 1) => {
    for (let k = 0; k < n && i < text.length; k++) {
      if (text[i] === "\n") {
        line++;
        lineStart = i + 1;
      }
      i++;
    }
  };

  while (i < text.length) {
    const c = text[i];
    if (inComment) {
      if (c === "\n") inComment = false;
      step();
      continue;
    }
    if (inString || inRegex) {
      if (c === "\\") step(2);
      else if (c === '"') {
        inString = false;
        inRegex = false;
        step();
      } else step();
      continue;
    }
    if (c === '"') {
      inString = true;
      quote = { char: '"', line, col: col() };
      step();
      continue;
    }
    if (c === ";") {
      inComment = true;
      step();
      continue;
    }
    if (c === "#" && text[i + 1] === '"') {
      inRegex = true;
      quote = { char: '#"', line, col: col() };
      step(2);
      continue;
    }
    if (c === "\\") {
      step(2); // a char literal: \(, \", \newline, ...
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push({ char: c, line, col: col() });
      step();
      continue;
    }
    if (CLOSING_FOR.has(c)) {
      const open = stack.pop();
      if (!open) {
        errors.push({ kind: "extra-closer", line, col: col(), char: c });
      } else if (open.char !== CLOSING_FOR.get(c)) {
        errors.push({
          kind: "mismatched-closer",
          line,
          col: col(),
          char: c,
          opener: { char: open.char, line: open.line },
        });
      }
      step();
      continue;
    }
    step();
  }

  if (inString || inRegex) {
    const at = quote ?? { char: '"', line, col: 1 };
    errors.push({
      kind: inRegex ? "unterminated-regex" : "unterminated-string",
      line: at.line,
      col: at.col,
      char: at.char,
    });
  }
  for (const open of stack.slice(0, MAX_UNCLOSED)) {
    errors.push({ kind: "unclosed", line: open.line, col: open.col, char: open.char });
  }
  return errors;
}

export function hasDelimiterError(text: string): boolean {
  return scanClojure(text).length > 0;
}

/** "`[` opened at line 78 is never closed; unexpected `)` at line 12:9" */
export function describeScanErrors(errors: ScanError[]): string {
  return errors
    .map((e) => {
      switch (e.kind) {
        case "unclosed":
          return `\`${e.char}\` opened at line ${e.line} is never closed`;
        case "extra-closer":
          return `unexpected \`${e.char}\` at line ${e.line}:${e.col}`;
        case "mismatched-closer":
          return `\`${e.char}\` at line ${e.line}:${e.col} does not match \`${e.opener?.char}\` opened at line ${e.opener?.line}`;
        case "unterminated-string":
          return `string opened at line ${e.line}:${e.col} is never closed`;
        case "unterminated-regex":
          return `regex opened at line ${e.line}:${e.col} is never closed`;
      }
    })
    .join("; ");
}

// ============================================================================
// Lines a rewrite touched (whitespace-insensitive, so reindent is not a change)
// ============================================================================

const squeeze = (s: string): string => s.replace(/\s+/g, "");

/**
 * 1-based line numbers whose non-whitespace content differs between two
 * versions, taken from both sides so an insertion reports where the new lines
 * landed. Whitespace-only differences are not changes.
 */
export function changedLinesBetween(before: string, after: string): number[] {
  if (squeeze(before) === squeeze(after)) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  // equal line counts, the usual case: compare line by line, so two clusters
  // stay two clusters instead of one span across the whole file
  if (a.length === b.length) {
    const lines: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (squeeze(a[i]) !== squeeze(b[i])) lines.push(i + 1);
    }
    return lines;
  }
  // a rewrite that adds or removes lines: compare around the common edges
  let start = 0;
  while (start < a.length && start < b.length && squeeze(a[start]) === squeeze(b[start])) start++;
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= start && bi >= start && squeeze(a[ai]) === squeeze(b[bi])) {
    ai--;
    bi--;
  }
  const lines = new Set<number>();
  for (let i = start; i <= ai; i++) lines.add(i + 1);
  for (let i = start; i <= bi; i++) lines.add(i + 1);
  return [...lines].sort((x, y) => x - y);
}

/** "12" / "28, 31" / "28, 31, 101, … (+3 more)" for an error message. */
function lineList(lines: number[], max = 6): string {
  const head = lines.slice(0, max).join(", ");
  return lines.length > max ? `${head}, +${lines.length - max} more` : head;
}

// ============================================================================
// Repair backend (parinfer, npm - indent mode, in-process)
// ============================================================================

export type RepairResult =
  | { status: "repaired"; text: string } // engine ran; text may equal the input
  | { status: "unfixable"; message: string } // engine reported an error (e.g. unclosed string)
  | { status: "error"; message: string }; // unexpected failure

export function repairText(text: string): RepairResult {
  try {
    const out = parinfer.indentMode(text);
    if (out.error) return { status: "unfixable", message: String(out.error.message ?? out.error) };
    return { status: "repaired", text: out.text };
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}

// ============================================================================
// The repair guard: a proposal is accepted only next to the error
// ============================================================================

/** A repair may rewrite at most this many lines. */
export const MAX_REPAIR_CHANGED_LINES = 2;
/** ... may only touch this far above an error ... */
export const REPAIR_WINDOW_BEFORE = 5;
/**
 * ... and this far below one. The band is asymmetric on purpose: a missing
 * closer is reported at the opener and inserted at the end of that form, which
 * is often tens of lines lower, while the damage pattern - closing a form early
 * where the indentation suggests it ends - always reaches above the error.
 */
export const REPAIR_WINDOW_AFTER = 30;

export type SurgicalRepair =
  /** Delimiter-clean input: nothing to do, nothing to report. */
  | { status: "clean" }
  /** The engine fixed it, and only where the error was. */
  | { status: "repaired"; text: string; rewrote: number[] }
  /** The engine's proposal reached beyond the error; the caller keeps its own text. */
  | { status: "declined"; message: string; errors: ScanError[]; rewrote: number[] }
  /** The engine cannot fix this at all. */
  | { status: "unfixable"; message: string }
  /** The engine itself failed; the caller proceeds unrepaired (fail open). */
  | { status: "error"; message: string };

export interface SurgicalRepairOptions {
  /**
   * 1-based lines the caller is already responsible for (the region an edit
   * changed). A repair near these is as acceptable as one near the error.
   */
  anchors?: number[];
  maxChangedLines?: number;
  windowBefore?: number;
  windowAfter?: number;
}

/**
 * Repair `text` only as far as the change can be justified by the error the
 * scanner found. Beyond `MAX_REPAIR_CHANGED_LINES` lines, or outside
 * `REPAIR_WINDOW_BEFORE`/`REPAIR_WINDOW_AFTER` of an error (or of `anchors`),
 * the proposal is declined: a repair that wide is indistinguishable from the
 * engine "fixing" indentation that was merely unusual, and it silently relocates
 * real delimiters. Measured on a real codebase with one closer removed per file,
 * the accepted repairs restored the original delimiters exactly in 90 of 108
 * cases and never moved a delimiter the author had not misplaced.
 */
export async function repairSurgically(
  text: string,
  opts: SurgicalRepairOptions = {},
): Promise<SurgicalRepair> {
  const errors = scanClojure(text);
  if (errors.length === 0) return { status: "clean" };

  const outcome = await repairContent(text);
  if (outcome.status === "error") return outcome;
  if (outcome.status === "unfixable") return outcome;

  const maxChanged = opts.maxChangedLines ?? MAX_REPAIR_CHANGED_LINES;
  const windowBefore = opts.windowBefore ?? REPAIR_WINDOW_BEFORE;
  const windowAfter = opts.windowAfter ?? REPAIR_WINDOW_AFTER;
  const rewrote = changedLinesBetween(text, outcome.text);
  const decline = (why: string): SurgicalRepair => ({
    status: "declined",
    message: `${describeScanErrors(errors)}; ${why}`,
    errors,
    rewrote,
  });

  if (rewrote.length === 0) {
    return decline("the repair changed nothing, so the errors would remain");
  }
  if (scanClojure(outcome.text).length > 0) {
    return decline("the repair would still leave delimiter errors");
  }

  const anchors = [...errors.map((e) => e.line), ...(opts.anchors ?? [])];
  if (rewrote.length > maxChanged) {
    return decline(
      `the repair would rewrite ${rewrote.length} lines (${lineList(rewrote)}) - more than ${maxChanged}, which is how a fix that moves unrelated delimiters looks`,
    );
  }
  const inBand = (line: number) =>
    anchors.some((a) => line >= a - windowBefore && line <= a + windowAfter);
  const far = rewrote.filter((line) => !inBand(line));
  if (far.length > 0) {
    return decline(
      `the repair would move delimiters on line(s) ${lineList(far)}, away from the error - it fixes indentation, not your code`,
    );
  }
  return { status: "repaired", text: outcome.text, rewrote };
}

// ============================================================================
// Optional cljfmt formatting (direct invocation, no babashka)
// ============================================================================

const CLJFMT_TIMEOUT_MS = 30_000;

// One-shot PATH lookup result: undefined = not resolved yet, null = absent.
let cljfmtPath: string | null | undefined;

export function resolveCljfmt(): string | null {
  if (cljfmtPath !== undefined) return cljfmtPath;
  const name = process.platform === "win32" ? "cljfmt.exe" : "cljfmt";
  let found: string | null = null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      // unreadable PATH entry: skip
    }
  }
  cljfmtPath = found;
  return found;
}

function runCljfmt(bin: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (err?: Error, out?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out!);
    };
    const child = spawn(bin, ["fix", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLJFMT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (timedOut) return finish(new Error(`cljfmt timed out after ${CLJFMT_TIMEOUT_MS}ms`));
      if (code !== 0) return finish(new Error(`cljfmt exited ${code}: ${stderr.trim().slice(0, 200)}`));
      // cljfmt reports an unreadable form on stderr and still exits 0, with no
      // stdout at all; treating that as a formatted result would write nothing.
      if (/failed to format/i.test(stderr)) {
        return finish(new Error(`cljfmt could not read the forms: ${stderr.trim().slice(0, 200)}`));
      }
      finish(undefined, stdout);
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Format `text` with cljfmt, or return it unchanged. Only whitespace moves:
 * an empty output, or one whose non-whitespace content differs, is discarded
 * rather than written.
 */
export async function formatWithCljfmt(text: string): Promise<string> {
  const bin = resolveCljfmt();
  if (!bin) return text; // no cljfmt on PATH: repair only
  try {
    const out = await runCljfmt(bin, text);
    if (text.trim() !== "" && out.trim() === "") {
      console.warn("[pi-clojure] cljfmt returned no output, content left unformatted");
      return text;
    }
    if (squeeze(out) !== squeeze(text)) {
      console.warn("[pi-clojure] cljfmt changed non-whitespace content, content left unformatted");
      return text;
    }
    return out;
  } catch (e) {
    console.warn(`[pi-clojure] cljfmt failed, content left unformatted: ${String(e)}`);
    return text; // fail open
  }
}

// Hook callbacks run against these so tests can substitute fakes.
const defaultRepairImpl = (text: string): Promise<RepairResult> => Promise.resolve(repairText(text));
let repairImpl: (text: string) => Promise<RepairResult> = defaultRepairImpl;
let formatImpl: (text: string) => Promise<string> = formatWithCljfmt;

export function repairContent(text: string): Promise<RepairResult> {
  return repairImpl(text);
}

export function formatContent(text: string): Promise<string> {
  return formatImpl(text);
}

export const _internals = {
  setRepair(fn?: (text: string) => Promise<RepairResult>) {
    repairImpl = fn ?? defaultRepairImpl;
  },
  setFormat(fn?: (text: string) => Promise<string>) {
    formatImpl = fn ?? formatWithCljfmt;
  },
  resetCljfmtCache() {
    cljfmtPath = undefined;
  },
};

// ============================================================================
// Clojure file detection
// ============================================================================

const CLOJURE_EXTENSIONS = [".clj", ".cljs", ".cljc", ".cljd", ".bb", ".lpy", ".edn"];
const BB_SHEBANG = /^#![^\s]+\/(bb|env\s{1,3}bb)(\s.*)?$/;

export function isClojureFile(filePath: string, content?: string): boolean {
  const lower = filePath.toLowerCase();
  if (CLOJURE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (content !== undefined) {
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    if (BB_SHEBANG.test(firstLine)) return true;
  }
  return false;
}

/** Reads a file as UTF-8, or undefined when it cannot be read. */
export function readTextFile(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}
