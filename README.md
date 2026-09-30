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
- Click the chevron or filename to fold a file. Folding or marking **Viewed** keeps an unfinished comment, indicated by **Draft**. Deleting comments or discarding changed drafts asks for confirmation.
- **Viewed** marks a file as read and folds it. It does not approve the code. Reopening a file does not clear the checkbox.
- **Copy review** exports the final Viewed checklist, all human comments and replies, their anchors/excerpts, and replied-to Agent notes. Other Agent notes are omitted. Finish or cancel a pending comment before copying. If automatic clipboard access fails, the Markdown remains visible for manual selection and copying.

English UI, system/light/dark themes, and responsive touch layouts are included. Mobile support means the web page layout and controls; it does not provide phone transfer, hosting, or guarantee that a mobile file previewer executes JavaScript.

## Boundaries

- **Browser-local feedback.** Viewed, comments, replies and changed drafts automatically save to `localStorage` per review snapshot. Refreshing or reopening the same HTML in the same browser restores them. Saved changes do not require copying before leaving; failed saves show a warning and request a best-effort browser confirmation when changes could be lost. An unreadable cache is kept intact and saving pauses until a reload can restore it. **Copy review** still copies Markdown for you to pass back to the agent; nothing writes back into the HTML or repository. Clearing browser data removes saved feedback. `file://` storage varies by browser; moving the HTML or using another browser does not guarantee recovery. Concurrent editing of the same snapshot in multiple tabs is unsupported; later saves can overwrite earlier ones.
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

Browser checks use Playwright with the installed Chrome channel by default. Set `PLAYWRIGHT_CHANNEL` to another installed Chromium channel, or install Playwright Chromium and set `PLAYWRIGHT_CHANNEL=bundled`. They cover `file://`, comments/replies/ranges, export and clipboard fallbacks, feedback/draft recovery and storage failures, mobile layout, malicious content, and a 200-file / 20,000-line rendering fixture. Clipboard success is mocked to avoid altering the system clipboard. Screenshots and test pages go to ignored `.test-output/`.

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
npm exec --yes --package ./revmap-0.1.1.tgz -- revmap --help
```

Runtime input and snapshot types live in `src/model.ts`; validation and Git access are separate from browser interaction and Markdown export. `src/core.ts` is a local test entry point, not a public package API.

## Publishing

Releases use GitHub Actions and npm's OIDC trusted publishing:

- `.github/workflows/publish.yml`: a push of a `v*` tag runs typecheck, Node tests and Chromium browser tests before `npm publish`. The pushed tag must exactly equal `v${package.json.version}`. `workflow_dispatch` runs checks only and must never publish, even when targeting a tag.
- Publish on GitHub-hosted `ubuntu-latest`, with Node 24/npm 11.19.1, `contents: read` and `id-token: write`; no stored npm publishing token. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) requires Node ≥22.14.0 and npm ≥11.5.1; verify the installed npm version. Self-hosted runners are unsupported.
- Bind npm trust exactly (case-sensitive) to `Andiedie/revmap`, workflow filename `publish.yml` (not its path), and environment `npm`. Explicitly allow direct `npm publish`, not just staged publishing. CLI management via [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires npm ≥11.15.0, an existing package, package write access and account 2FA; use `--allow-publish` when creating this trust.
- The publish job must reference environment `npm`. In GitHub's [environment rules](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments#creating-an-environment), choose **Selected branches and tags**, with only a **Tag** rule for `v*`—not a Branch rule or “Protected branches only.” Keep checks outside this tag-restricted job so manual runs on `main` can complete.
- [Provenance is automatic](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation) for OIDC publishing from a public repository to a public package; `--provenance` is unnecessary. Keep `package.json.repository.url` matched to this repository, including case.

For the next stable patch release, update and commit `CHANGELOG.md` on `main`, ensure a clean worktree, then:

```sh
npm version patch
git push --atomic origin main --follow-tags
```

Manual runs validate CI checks only. Saved npm trust settings are not validated by npm; verify successful OIDC publishing and provenance after each release.

Licensed under the [MIT License](LICENSE). Bundled third-party code retains its licenses in `dist/THIRD_PARTY_NOTICES.txt`.
