# pi-clojure

[pi](https://github.com/earendil-works/pi) extension for Clojure development. It repairs Clojure delimiter errors when the agent writes or edits Clojure files (zero extra LLM tokens), and adds a `clojure-nrepl-eval` tool that evaluates code against the project's nREPL server.

Self-contained: delimiter repair runs in-process through the [parinfer](https://www.npmjs.com/package/parinfer) npm package (`indentMode` — Parinfer's indent mode), the nREPL client (bencode wire protocol) is implemented in-process, and formatting runs [`cljfmt`](https://github.com/weavejester/cljfmt) directly when it is on `PATH`. No babashka, no external repair tool.

## Install

```bash
pi install /path/to/pi-clojure
```

The path is loaded in place, so a `git pull` in the checkout is live on the next `pi` start. `pi list` shows it, `pi remove /path/to/pi-clojure` drops it.

Try it for one session instead:

```bash
pi -e ./extensions/clojure/index.ts
```

Run `npm install` in this directory once first — the extension needs `parinfer`.

## What it does

| Tool | Before the call | After the call |
|------|-----------------|----------------|
| `write` | Content is repaired in-process (and formatted, if cljfmt is available) and replaced in the tool input. Content the repair cannot fix, or can only fix by moving unrelated delimiters, **blocks the write** before anything hits disk, with the reason in the tool error. | When the content was modified, the result carries a change note (current on-disk content, or a diff for large files) so the model does not act on a stale view. |
| `edit` | The file is backed up in memory (keyed by the tool call id). | The on-disk file is repaired and formatted. Rejected → the backup is restored, the result becomes an error naming the delimiter and its line, and the model is told to fix it and retry. Changed → the result carries a change note with the current on-disk content (small files) or a diff of the changed lines (large files), and says so if the repair touched lines the edit did not. |

Details:

- **Balanced code is never touched.** A Clojure-aware scanner (strings, char literals, line comments, regex literals, delimiter stack) reports where delimiters go wrong, and the repair engine only runs when they actually are unbalanced.
- **Repairs stay next to the error.** A repair proposal is accepted only when it rewrites at most two lines, each within five lines above or thirty below a reported error or the lines your edit changed. Anything wider is refused and your text is kept, with the error's line in the message. Parinfer's indent mode reads indentation as the truth, so in a file whose indentation does not match its delimiters one missing closer made it move delimiters on up to 33 lines, up to 1190 lines from the error — and the mangled file still parsed. The band is asymmetric because a missing closer is reported at its opener and inserted at the end of that form, often tens of lines lower, while closing a form early always reaches above the error. Measured on a Clojure codebase with one closer removed per file: 90 of 108 damaged files were repaired, each one restoring exactly the delimiters the author wrote, and none moved a delimiter the author had not misplaced.
- **Non-Clojure files are ignored.** A file counts as Clojure when its name ends in `.clj`, `.cljs`, `.cljc`, `.cljd`, `.bb`, `.lpy`, or `.edn` (case-insensitive), or its first line is a `#!/.../bb` or `#!/.../env bb` shebang.
- **cljfmt is optional, and only moves whitespace.** When a `cljfmt` executable is found on `PATH`, every repaired (or clean) Clojure result is formatted with `cljfmt fix -` (stdin to stdout, 30s timeout). Output that is empty, or that differs in any non-whitespace character, is discarded — cljfmt exits `0` with no output at all when it cannot read the forms. Otherwise formatting is skipped and only delimiter repair happens.
- **Fail open, except for repairs that would reach too far.** If repair or formatting fails for any other reason, the operation proceeds with the un-repaired content and a warning is logged.
- **Relative paths** (e.g. `foo.clj`) resolve against pi's working directory, the same way the built-in `write` and `edit` tools resolve them.
- Repair writes go through pi's `withFileMutationQueue`, so they serialize with the built-in file tools on the same path.

## REPL evaluation

The extension registers a `clojure-nrepl-eval` tool so the model can evaluate Clojure against the project's nREPL server without any external binary:

- **State persists between calls.** One persistent nREPL session per host:port (created with `clone`, re-validated with `ls-sessions` after any reconnect), so a namespace required in one call is available in the next.
- **Repair first.** The same delimiter repair runs on the code before evaluation; code the repair cannot fix locally is rejected with an error naming the delimiter and its line, instead of being evaluated.
- **Port discovery.** An explicit `port` argument, otherwise `.nrepl-port` (or `.shadow-cljs/.nrepl-port`) in the working directory.
- **Timeouts.** 120s by default, per-call `timeoutMs`; on timeout the running evaluation is interrupted via nREPL's `interrupt` op. The same happens when you abort the turn.

Input: `{ code, port?, host? (default 127.0.0.1), timeoutMs? }`. Results carry the evaluated values (`=>`), stdout/stderr, the active namespace, and any exception with a truncated trace. Evaluation errors (an exception thrown by the code) come back as normal results so the model can read them; operational failures (no port, connection refused, timeout, unfixable code) fail the tool call.

## Limits

- Only `write` and `edit` are repaired — pi has no patch tool, and files a shell command writes (`sed -i`, redirection, `git apply`) are left alone.
- nREPL sockets open lazily on the first evaluation and close on `session_shutdown`.

## Requirements

- pi 1.3.0 or newer.
- Optionally, [`cljfmt`](https://github.com/weavejester/cljfmt) on `PATH` for formatting (standalone binary, `clj -Ttools`, or any wrapper exposing a `cljfmt` command that accepts `fix -`).

## Development

```bash
npm install
npm test          # node --test: unit tests + integration tests
npm run typecheck # strict tsc, no build step
```

The integration tests run the real in-process parinfer, the real `cljfmt` when it is on `PATH` (skipped gracefully otherwise), and a fake in-process bencode nREPL server for the `clojure-nrepl-eval` tool.

Layout: `extensions/clojure/repair.ts` (delimiter scanner, local repair guard, parinfer, cljfmt), `extensions/clojure/nrepl.ts` (bencode client, eval), `extensions/clojure/notes.ts` (change notes), `extensions/clojure/index.ts` (the pi extension: tool hooks, the tool, cleanup).

## Acknowledgements

Ported from [opencode-clojure](https://github.com/brutasse/opencode-clojure), this project's OpenCode v2 plugin, which in turn took its inspiration from [clojure-mcp-light](https://github.com/bhauman/clojure-mcp-light).
