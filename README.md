# revmap

**Review map:** an agent orders and annotates a set of changed files; a human reviews them in a GitHub-style page and copies feedback back to the agent.

One JSON input → one self-contained HTML file. No server, model API, accounts, or runtime network requests.

Release notes: [CHANGELOG.md](CHANGELOG.md).

## Use

Install the agent Skill:

```sh
npx skills add Andiedie/revmap
# Explicitly ask your agent to use revmap for the changes you want to review.
```

Or run the CLI directly inside a Git repository:

```sh
npx revmap --input /path/to/review.json
```

Minimal input:

```json
{"files":[{"path":"src/app.ts"}]}
```

The CLI opens a temporary `file://` page in your default browser and prints its URL. `--no-open` generates it without opening a browser. Git and a working Node.js/npm environment are required; no global revmap installation or end-user build step is needed. No `engines` version gate is imposed; runtime code targets mature Node APIs.

### What is compared?

| Input | Comparison |
| --- | --- |
| No `base` | `HEAD` → final working tree; staged and unstaged changes combined |
| `base` supplied | That commit → final working tree; includes later commits and uncommitted changes |
| Repository with no commits | Empty version → working tree |

Only listed files are included, in the supplied order. Explicitly selected untracked files count as additions. Paths are repository-root-relative, not relative to the JSON file. `base` accepts a Git commit reference; the resolved commit is recorded in the page. A clean working tree with no `base` has no uncommitted changes.

See the [input contract and annotated example](skills/revmap/SKILL.md#input) for priorities, Markdown notes, line ranges and explicit renames. [`examples/review.json`](examples/review.json) is a runnable plan for this repository. Invalid input fails with a field name and repair hint rather than silently omitting data.

### Review and copy

- Read in the agent's order. **Focus / Normal / Can skim** tags distinguish priorities without reordering files; low-priority files start folded.
- Use unified or split diffs, expand unchanged context, and leave file or line comments. Hold a line's **+** and drag up or down to select a range; release to comment. The selection highlights live and scrolls at the page edge. Shift-click also selects a range. For touch or keyboard use without dragging, click a line, choose **Select end line**, then choose the last line. No line numbers need to be typed. Reply to initial Agent notes or your own discussions. Your comments can be edited or deleted; Agent notes are read-only.
- Click the chevron or filename to fold a file. Folding or marking **Viewed** keeps an unfinished comment in memory, indicated by **Draft**. Deleting comments or discarding changed drafts asks for confirmation.
- **Viewed** marks a file as read and folds it. It does not approve the code. Reopening a file does not clear the checkbox.
- **Copy review** exports the final Viewed checklist, all human comments and replies, their anchors/excerpts, and replied-to Agent notes. Other Agent notes are omitted. Finish or cancel a pending comment before copying. If automatic clipboard access fails, the Markdown remains visible for manual selection and copying.

English UI, system/light/dark themes, and responsive touch layouts are included. Mobile support means the web page layout and controls; it does not provide phone transfer, hosting, or guarantee that a mobile file previewer executes JavaScript.

## Boundaries

- **Single round, in-memory state.** Closing or refreshing asks for confirmation when comments, drafts or Viewed changes have not been copied. Successful copying clears the warning until further changes; merely opening the export or a failed copy does not. Browser confirmation is best-effort, especially on mobile or forced app termination. Nothing writes back into the HTML or repository; reloading still resets the review.
- **Local snapshot.** The CLI exits after generating/opening the page. Later file changes do not update it. The page contains selected source code; keep the HTML private unless you intentionally share it. Temporary files are left for the user/OS to clean up.
- **No task inference.** The caller chooses files and `base`. revmap does not isolate changes made before a conversation or infer rename sources.
- **Special files.** Binary/non-UTF-8 content is not embedded or previewed. Symlinks show their target text without following them. Submodules show commit references, not nested changes. Binary files and submodules support file comments only. Version modes and content are compared, including empty files and executable-bit changes.
- **Large reviews.** Files render as they enter view; large diffs require explicit loading and are paginated. Source text is embedded so unchanged context remains available offline. Git output is buffered with a 256 MiB per-command ceiling; unusually large files can still exhaust memory. This is not a streaming repository viewer.
- **Safety.** Literal paths, traversal checks, escaped source text, Markdown without raw HTML, and a restrictive content security policy protect the local page. Git hooks, external diff and text conversion are not run. Automatic browser opening uses argument arrays, not a shell.

## Develop and verify

```sh
npm ci
npm run check
npm test
npm run test:browser
node dist/cli.cjs --input examples/review.json
npm pack
```

Browser checks use Playwright with the installed Chrome channel by default. Set `PLAYWRIGHT_CHANNEL` to another installed Chromium channel, or install Playwright Chromium and set `PLAYWRIGHT_CHANNEL=bundled`. They cover `file://`, comments/replies/ranges, export and clipboard fallbacks, reset, mobile layout, malicious content, and a 200-file / 20,000-line rendering fixture. Clipboard success is mocked to avoid altering the system clipboard. Screenshots and test pages go to ignored `.test-output/`.

Focused interaction regressions also check hover/keyboard focus, draft safety, selection, horizontal scrolling, clipboard waiting, and touch controls. To run them with WebKit instead of Chrome:

```sh
npx playwright install webkit
REVMAP_EDGE_BROWSER=1 PLAYWRIGHT_ENGINE=webkit node --test test/interaction.test.cjs
```

To verify Skill discovery without installing it:

```sh
npx skills add . --list
```

The published package includes the compiled CLI and embedded browser assets, Skill and example; dependencies are bundled. A local package can be exercised without publishing:

```sh
npm exec --yes --package ./revmap-0.1.0.tgz -- revmap --help
```

Runtime input and snapshot types live in `src/model.ts`; validation and Git access are separate from browser interaction and Markdown export. `src/core.ts` is a local test entry point, not a public package API.

Licensed under the [MIT License](LICENSE). Bundled third-party code retains its licenses in `dist/THIRD_PARTY_NOTICES.txt`.
