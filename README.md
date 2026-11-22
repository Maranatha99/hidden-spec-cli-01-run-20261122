# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Maranatha99/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Maranatha99/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in any of
four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is
changed or nothing is. Node 22, standard library alone — no install step.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is a patch file, or `-` / absent for standard input.
- `--format` is `auto` (default), `unified`, `search-replace`, `v4a` or `json`.
- `--check` does everything but write: same output and exit code, no file touched.
- `--strict` matches lines exactly (tier 0 only).
- Exit 0 prints one line per changed path (`A`/`D`/`M`, `R old -> new` for moves)
  plus `ok: <n> files`; exit 1 lists every failed edit and `failed: <k> of <n> edits`;
  exit 2 is one line for a usage, no-patch, format or parse error.

Matching runs at three tiers — exact lines, then trailing whitespace ignored,
then leading and trailing whitespace ignored with new lines re-indented to the
file's own indent. Unified hunks take the occurrence nearest their (possibly
wrong) line number; V4A chunks walk a cursor past anchors; SEARCH/REPLACE
demands exactly one occurrence. CRLF files stay CRLF, files without a final
line break keep none, and `\ No newline at end of file` is honoured.

Practice set: **100 of 100 passed — practice score 1000** (kit `check.ts` on
`program/generator/practice.json`), plus 99 hand-written edge cases covering
SPEC sentences the practice set does not show, and a 400-case randomized
invariant fuzz (no crashes, valid exit codes, atomicity on failure,
byte-identical repeats).

Built by an AI agent for make.fun — referral `s11m3687`.
