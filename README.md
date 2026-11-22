# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dankurniaone/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dankurniaone/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. AI models write edits four different ways — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — and every public applier reads only one of them. mend reads all four to one written contract, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only, nothing to install. `PATCH` is the patch file; when it is absent or `-`, the patch is read from standard input. The working directory is the root of the tree the patch applies to.

```sh
node main.ts fix.patch            # apply a unified diff from a file
cat patch.json | node main.ts -   # apply JSON edits from stdin
node main.ts --check fix.patch    # dry run: same output, nothing written
node main.ts --strict fix.patch   # tier-0 exact matching only
node main.ts --format=v4a fix.patch
```

## How it works

- **Four readers, one contract.** Unified diffs (section 6 of `SPEC.md`), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and JSON edits (section 9) all become the same list of edits: create, change, delete or move a file.
- **Three matching tiers.** An edit's old lines are found at the first tier where they occur: exact (tier 0), ignoring trailing whitespace (tier 1), or ignoring leading and trailing whitespace (tier 2). At tier 2 the new lines are re-indented to the file's own indentation, and context lines are always written back as the file's own lines. `--strict` pins matching to tier 0. Unified hunks take the occurrence nearest the line number the diff names; SEARCH/REPLACE blocks require exactly one occurrence; V4A chunks walk a cursor through the file, anchored by `@@` lines and `*** End of File`.
- **All or nothing.** Edits apply in patch order to the tree as earlier edits left it. A failed edit changes nothing and the edits after it still run, so every failure is reported — then, when any edit failed, no file is written at all (exit 1). On success the tool prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a move) and `ok: <n> files`.
- **Safe paths and exact output.** Paths must be relative, with no empty, `.` or `..` segments and no backslashes. Output is exactly the lines `SPEC.md` prescribes and nothing else; standard error is never compared.

## Files

- `main.ts` — the whole tool.
- `SPEC.md` — the specification it implements, version 1.
- `runner.ts` — the kit's trial runner (unchanged from the kit): reads checks from the trial env and runs `main.ts` on each.
- `check.ts` — run the public practice set locally: `node check.ts <kit>/program/generator/practice.json`.
- `.makefun/owner.json` — the payout wallet that owns this entry.

## Practice score

100 of 100 practice checks pass (practice score 1,000), verified with the kit's own checker and with a trial-env replay of the same 100 checks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
