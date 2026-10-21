# Telmoni for Claude Code — Agent Guidelines

The Claude Code plugin for Telmoni ([`telmoni/claude-observability-plugin`](https://github.com/telmoni/claude-observability-plugin)): a hook that records each turn of a person's Claude Code sessions as a run, metadata only, through the TypeScript SDK of the platform ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/typescript`). It reaches a person's machine as the npm package `@telmoni/claude-observability-plugin` alone, which this repository's marketplace, `telmoni-plugins`, names. The repository is public, and every file in it is published as written.

## Ground Rules
- **Pre-launch:** nothing has shipped. Change the record, the state and the manifests to their ideal state; no migration paths.
- **Quality gate:** never weaken a test or leave the tree broken.
- **Ask first:** any dependency change (an edit to `package.json` or `package-lock.json`, lockfile-only refreshes included) and any external-state change (publishing to npm, a listing in a vendor's directory, a call to a live Telmoni with a real key).
- **Metadata only, by construction:** a record holds a model, token counts, tool names, skill names, subagent kinds, times and outcomes. Never a prompt, a reply, a thought, a tool's input or output, a file's path, the working folder or an email — the hook reads a transcript no further than it takes to find those, and keeps nothing else.
- **The session never waits:** the hook hands its work to a detached copy of itself and exits at once; a failure is a line in `hook.log` naming its kind, never anything from the session, and the hook exits 0 whatever happened.

## Where Things Live
| Path | What |
|---|---|
| `src/hook.ts` | The entry Claude Code runs: reads its input, starts the detached copy, exits. |
| `src/session.ts` | One hook's work on one session: the turns ended since the last hook, each sent and its place saved. |
| `src/transcript.ts` | The transcript read as far as the metadata goes, and cut into turns. |
| `src/record.ts` | A turn as the SDK's `RunRecord`; the run id derived from the session and the turn's opening entry. |
| `src/send.ts`, `src/state.ts`, `src/settings.ts`, `src/input.ts`, `src/log.ts` | Sending through the SDK; each session's state and lock; the key, endpoint and folder; the hook's input; `hook.log`. |
| `tests/` | The suites; `tests/fixtures/` holds recorded sessions with every text scrubbed and every id renamed. |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | The plugin, shipped in the package: its user configuration (the key, marked sensitive, which Claude Code keeps with its own credentials) and its three hooks. |
| `.claude-plugin/marketplace.json` | The marketplace, `telmoni-plugins`, naming the plugin by its npm package: an install fetches the package as built, never a build of the clone. |
| `ARCHITECTURE.md` | How the plugin works, and why. |
| [`telmoni/telmoni`](https://github.com/telmoni/telmoni) | Sibling repo, checked out as `../telmoni`: the SDK this plugin is built on (`sdk/typescript`, `recordRun`), which it takes from npm as `telmoni`. |
| [`telmoni/docs`](https://github.com/telmoni/docs) | Sibling repo, checked out as `../docs`: the book, whose `api/coding-agents.mdx` documents this plugin. |

## Commands
- **After every change** (no permission needed; report failures verbatim): `make check` — the types, the bundle and the suites (`npm run verify`), then `claude plugin validate --strict` on the marketplace and the plugin.
- **Locally:** `claude --plugin-dir .` starts a Claude Code session with this checkout's plugin loaded, its hook the `dist/hook.mjs` last built; `TELMONI_API_KEY` and `TELMONI_ENDPOINT` reach it as the plugin's own configuration would.

## Code Rules
- TypeScript on Node 22, bundled by tsup into the one file `dist/hook.mjs` with the SDK inside it: Claude Code installs the package with no install scripts and no dependencies. Nothing built is committed.
- Everything that leaves goes through the SDK's `recordRun`, never a request of the plugin's own: the contract, the content rules and the retries are the SDK's.
- Comments are for a person reading the code, and short: they say *why*, never *what* — a doc comment in a line or two, an inline comment in one, a test's doc in one line on what it proves. The reasoning behind a change (a race worked through, the designs turned down, its history) goes in `ARCHITECTURE.md` or the commit message, never above a function, and editing a comment means shortening its whole block. No AI signatures anywhere.
- Never log a key, a token or anything read from a session; log kinds.

## Agent Hygiene
- **This repo only:** change nothing in another repository unless the user says so for this task; that binds subagents too. Reading is fine.
- Edit `AGENTS.md` only when the user asks outright; otherwise propose a diff.
- No scripted bulk edits. One-off scripts and logs go in `/tmp/telmoni/`. A fixture is scrubbed before it is written here: kept fields allowlisted, every text replaced, every id renamed, every time shifted.
- Never read, print or copy a `.env` file or Claude Code's credentials, and never put a real key in a test, a fixture or a commit.

## Git Rules
- Commit only when asked: never `git add` or `git commit` unprompted.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) of 1–5 lines and the sign-off: a subject, then optionally a blank line and up to 3 lines on *why*. No file lists, test output, AI signatures or `Co-authored-by` trailers.
- Every commit is signed off by the developer it is made for, certifying the [Developer Certificate of Origin](https://developercertificate.org/): `git commit -s` adds `Signed-off-by: Name <email>` from git's `user.name` and `user.email`, which name a person, never an agent.
- No branches, worktrees, pushes or pull requests.

## Definition of Done
- [ ] `make check` passes, or the failure is reported verbatim.
- [ ] No key, no text from a session and no path reaches a log, a record, a fixture or a commit.
- [ ] `ARCHITECTURE.md` and `README.md` say what changed, and the book's `api/coding-agents.mdx` (`../docs`) is fixed or named.
- [ ] Nothing that needs asking happened unasked (dependencies, publishing, live calls, other repos, commits).
