---
name: revmap
description: Build an ordered, annotated review of local code changes for a human in a self-contained HTML page. Use only when the user explicitly requests revmap.
disable-model-invocation: true
---

# revmap

Create a review map when the user explicitly asks for it. Finish by opening one local review page and reporting its file URL. The human reviews and copies Markdown feedback back into the conversation.

## Prepare the review

1. Inspect the requested changes and select the files the human should review. Order files by a useful reading sequence: prerequisites before callers, behavior before mechanical changes. For distinct review topics, use single-level groups organized by change goal or semantic flow; choose both group order and the reading order within each group. Set priority separately from reading order. Include skippable files explicitly with low priority if they should remain visible. The CLI never adds files, infers groups, or reorders the plan.
2. Choose the comparison:
   - Omit `base` for the selected files' current uncommitted changes: `HEAD` to the final working tree, combining staged and unstaged changes and including explicitly selected untracked files. An unborn repository uses an empty base.
   - Set `base` to the commit **before the changes being reviewed** when the review includes one or more commits, including any later uncommitted edits. The endpoint is always the working tree, not another commit. For a single ordinary commit this is usually its parent; for several commits use the commit before the first one in scope.
   - Review the final net result, not intermediate commits. A clean working tree without `base` has no uncommitted diff. The CLI neither infers task boundaries nor separates pre-existing edits.
3. Normally add a short review-level Markdown note describing the goal, selected scope, major changes and review focus so the human has context on opening the page. Add group notes explaining how the files work together and what to check across them. Add file-level notes when the purpose or impact is not obvious: why this file changed and what changed. Explain rationale and consequences rather than narrating the diff. Use line notes for precise invariants, risks or checks, grounding line numbers in the correct version. For removed lines use `side: "old"`; current working-tree lines use `"new"`.
4. Write the JSON to the operating system's temporary directory, not the repository. Use the format below. A valid plan contains only explicitly selected files, in review order, with accurate anchors.

## Input

The minimum plan is `{"files":[{"path":"src/app.ts"}]}`. Existing flat plans remain valid. Use either top-level `files` or `groups`, never both; each file appears once across the whole plan.

```json
{
  "base": "abc123",
  "files": [
    {
      "path": "src/app.ts",
      "priority": "high",
      "comments": [
        { "text": "Start with the new validation path." },
        { "line": 42, "text": "Check the failure case here." },
        { "line": 60, "endLine": 75, "text": "This range changes error propagation." },
        { "side": "old", "line": 30, "text": "Confirm the removed fallback is no longer needed." }
      ]
    },
    { "path": "src/new.ts", "oldPath": "src/old.ts", "priority": "low" }
  ]
}
```

A grouped plan adds review-wide and group context without changing the file contract:

```json
{
  "comments": [{ "text": "Review the validation change and its UI integration. Start with the input contract, then check the error path." }],
  "groups": [
    {
      "title": "Validation behavior",
      "comments": [{ "text": "Check that validation and callers agree on accepted input and failures." }],
      "files": [
        { "path": "src/input.ts", "priority": "high", "comments": [{ "text": "Reject ambiguous input before reading the repository." }] },
        { "path": "src/app.ts" }
      ]
    },
    { "title": "Supporting updates", "files": [{ "path": "README.md", "priority": "low" }] }
  ]
}
```

Replace example paths, commit and coordinates with actual values.

- `files`: a nonempty array for a flat plan. `path`: required literal repository-root-relative file path, even when running from a subdirectory. List files, not directories or globs; one entry per path.
- `groups`: alternatively, a nonempty ordered array of `{ "title": "...", "comments": [{ "text": "..." }], "files": [...] }`. Title and a nonempty file list are required; comments are optional. Groups are single-level and group/file order is preserved. Groups start expanded; folding a group hides its files but keeps its title and comments available. Viewed remains per file.
- Top-level and group-level `comments`: optional arrays of nonempty Markdown `{ "text": "..." }` notes; these scopes have no line, endLine or side.
- `base`: optional commit reference; omitted means `HEAD` (or empty base in an unborn repository).
- `oldPath`: optional explicit rename source in the base. It must differ from `path`, exist in the base, and the destination must exist in the working tree. No rename guessing occurs.
- `priority`: use `high` (Focus) for critical behavior or high-risk changes, `normal` (Normal, default) for ordinary or supporting behavior, and `low` (Can skim) for mechanical or ancillary changes that can safely be skimmed. High/normal start expanded; low starts collapsed. Very large diffs require explicit loading. Priority never changes reading order or marks a file Viewed.
- File-level `comments`: optional array. `text` is required, nonempty Markdown. Omit `line` for a file note. Otherwise `line` is the first 1-based line, `endLine` is inclusive and defaults to `line`, and `side` is `old` or `new` (default). A range belongs to one side.
- Binary/non-UTF-8 files and submodules support file notes only. Symlinks are reviewed as their target text, without dereferencing them. Unchanged text files can still have notes on their contents.

Unknown fields, unsafe/missing paths, invalid commits and invalid anchors fail with field-local errors. Fix the indicated input and retry; preserve the intended review scope rather than dropping the offending file or note.

## Open and hand back

From inside the target repository, run:

```sh
npx --yes revmap --input /absolute/path/to/temporary-review.json
```

The CLI prints a `file://` URL and opens the default browser, then exits. `--no-open` only generates the page and prints its URL. If browser launch fails, hand the printed URL to the user; the generated page is still usable.

The page contains the snapshot and all its assets. It needs no server or model connection. Viewed, comments, replies and changed drafts save in browser-local storage for this snapshot. When storage is available, refreshing or reopening the same HTML in the same browser restores them; generating a new review does not migrate feedback. The generated file contains selected source code, so treat it as sensitive and share it only at the user's request.

Tell the user the page is ready and provide the URL. The human can comment on the review, groups, files or lines, reply to notes, mark files Viewed, and use **Copy feedback**. The exported Markdown includes the per-file Viewed checklist, group titles when present, human feedback from every scope, and any Agent note needed as reply context; filters do not limit the export. No automated return channel or later synchronization exists; a later review is a fresh invocation chosen by the user and agent.
