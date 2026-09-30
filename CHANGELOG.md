# Changelog

## 0.1.4

- Add review-wide context and feedback, plus ordered single-level file groups with group comments. Group folding keeps headings and discussions visible; Viewed remains per file.
- Include review and group discussions in comment navigation, draft recovery, and Copy feedback, preserving the supplied reading order and exporting feedback across all filters.
- Give file-level notes a distinct context style instead of presenting them like inline code discussions.
- Follow the system light/dark preference automatically, remove the manual theme control and Local snapshot badge, and label human comments and exported feedback as User instead of You.
- Keep flat review inputs and existing file-only feedback caches compatible; update the bundled Skill and example for review-wide and grouped plans.

## 0.1.3

- Keep file and discussion navigation, diff layout controls, and Copy feedback in a fixed review toolbar; file headers stay visible directly below it.
- Navigate through files and discussion threads in the current filter, track manual scrolling, and preserve drafts and Viewed state. Mobile file navigation opens as an overlay without losing the reading position.
- Rename Copy review to Copy feedback, copy all feedback regardless of filters, and show copying/success inline. Reveal unfinished drafts before export and open the Markdown dialog only when automatic copying fails.

## 0.1.2

- Keep each file header visible while scrolling its diff, with Viewed and other file actions accessible until the next file takes over.
- Show compact filenames in navigation; add the shortest distinguishing parent path only for same-named files, and truncate long paths without growing navigation items. Full paths remain available in file headers and search.

## 0.1.1

- Automatically save Viewed, comments, replies and changed drafts in browser-local storage per review snapshot; restore them when refreshing or reopening the same HTML in the same browser.
- Warn before leaving only when changes have not been saved. Show storage failures with a retry action, and keep unreadable caches intact instead of overwriting them.
- Fix clipped inline reply inputs and submit buttons in narrow layouts and horizontally scrolled diffs.
- Publish through GitHub Actions with npm OIDC trusted publishing, after typecheck, Node tests and Chromium browser tests pass.

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
