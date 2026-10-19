/**
 * Change notes: the result text the extension attaches to a write or edit whose
 * on-disk content differs from what the model produced.
 *
 * When the extension rewrites a file after the model's write/edit, the model's
 * in-context view of that file is stale and further edits built on it will
 * fail. The tool result therefore carries a change note: the full current
 * on-disk content when the file is small enough, otherwise a line diff of what
 * changed, so the model can continue editing without acting on stale content.
 */

export type ChangeReason = "repaired" | "formatted";

export const FULL_MAX_LINES = 200;
export const FULL_MAX_BYTES = 8_192;
export const DIFF_MAX_LINES = 60;
export const NOTE_TOTAL_MAX_BYTES = 16_384;

// Dependency-free line diff: trims the common prefix/suffix and lists the
// changed middle, one side at a time, each line numbered with its position
// in that side's version. "" when the texts are identical.
export function diffText(before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldStop = oldLines.length;
  let newStop = newLines.length;
  while (oldStop > start && newStop > start && oldLines[oldStop - 1] === newLines[newStop - 1]) {
    oldStop--;
    newStop--;
  }
  const lines: string[] = [];
  for (let i = start; i < oldStop; i++) lines.push(`-${i + 1}: ${oldLines[i]}`);
  for (let i = start; i < newStop; i++) lines.push(`+${i + 1}: ${newLines[i]}`);
  return lines.join("\n");
}

// Full-file content with line numbers, in the read tool's style.
export function numberedContent(text: string): string {
  return text
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}

function reasonPhrase(reasons: ChangeReason[]): string {
  const repaired = reasons.includes("repaired");
  const formatted = reasons.includes("formatted");
  if (repaired && formatted) return "delimiter errors were repaired and cljfmt reformatted it";
  if (repaired) return "delimiter errors were repaired automatically";
  if (formatted) return "cljfmt reformatted it";
  return "the content was modified";
}

export function buildChangeNote(
  file: string,
  before: string,
  after: string,
  reasons: ChangeReason[],
  warnings: string[] = [],
): string {
  const lines = [
    `⚠ Auto-repair note: ${file}`,
    `Your change was applied, but ${reasonPhrase(reasons)} - the file on disk differs from what you wrote:`,
    // warnings describe changes the model did not ask for, so they come before
    // the content they refer to
    ...warnings,
  ];
  const afterLineCount = after.split("\n").length;
  if (afterLineCount <= FULL_MAX_LINES && Buffer.byteLength(after, "utf8") <= FULL_MAX_BYTES) {
    lines.push("Current on-disk content:", numberedContent(after));
  } else {
    lines.push(
      "Changed lines (- = what your change produced, + = what is on disk now; numbers are line numbers in each side's version):",
    );
    // the cap is split across both sides so the + (current) side is never
    // fully cut off
    const diff = diffText(before, after).split("\n");
    const plusStart = diff.findIndex((line) => line.startsWith("+"));
    const removed = diff.slice(0, plusStart < 0 ? diff.length : plusStart);
    const added = plusStart < 0 ? [] : diff.slice(plusStart);
    const perSide = Math.ceil(DIFF_MAX_LINES / 2);
    const shown = [...removed.slice(0, perSide), ...added.slice(0, perSide)];
    const omitted = Math.max(0, removed.length - perSide) + Math.max(0, added.length - perSide);
    lines.push(...shown);
    if (omitted > 0) {
      lines.push(`... (${omitted} more changed lines - re-read the file for the full current content)`);
    }
  }
  return lines.join("\n");
}

// Joins per-file change notes under a byte budget; a file whose note does
// not fit gets a one-line re-read notice instead.
export function assembleChangeNotes(
  changes: { file: string; before: string; after: string; reasons: ChangeReason[]; warnings?: string[] }[],
  budget = NOTE_TOTAL_MAX_BYTES,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const change of changes) {
    const note = buildChangeNote(change.file, change.before, change.after, change.reasons, change.warnings);
    const size = Buffer.byteLength(note, "utf8");
    if (used + size > budget) {
      parts.push(`⚠ Auto-repair note: ${change.file} - further changes omitted; re-read the file.`);
      continue;
    }
    used += size;
    parts.push(note);
  }
  return parts.join("\n\n");
}
