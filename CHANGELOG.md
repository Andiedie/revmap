# Changelog

## 0.1.0

Initial release.

- Run `revmap --input <review.json>` inside a Git repository to generate and open a self-contained, offline review page.
- Review only the ordered files selected by the agent, comparing the working tree with `HEAD` or an explicit base commit.
- Use GitHub-style unified/split diffs, expandable context, review priorities, and Viewed tracking.
- Add file comments, drag-selected line-range comments, and threaded replies; export human feedback as Markdown.
- Keep unfinished drafts while folding files, confirm destructive comment actions, and warn before leaving with uncopied changes.
- Handle explicit renames, deleted files, binary metadata, symlinks, and submodule references.
- Support light/dark themes, responsive layouts, touch controls, and keyboard interaction.
- Include the agent Skill, discoverable with `npx skills add Andiedie/revmap`.

Review state remains in memory only. Mobile support covers responsive layout, not transferring or hosting the generated HTML. See [README.md](README.md#boundaries) for limitations.
