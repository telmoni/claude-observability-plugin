# Claude Code Plugin — Agent Guidelines

The Claude Code plugin for Telmoni: a hook that records each turn of a person's Claude Code sessions as a run, metadata only, through the platform's Python SDK. The repository is the plugin and its own marketplace: Claude Code clones it and runs the hook from the clone, so every file here is published as written.

## Ground Rules
- **Metadata only.** The hook reads of a transcript its kinds, ids, times, counts and flags, the first characters of a user row for Claude Code's markers, and the tool-use id a task's notice names. Never keep, log or send a prompt, a reply, thinking, a path, the working folder, or a tool's input or output beyond a skill's name and a subagent's kind. A change that reads more of the transcript needs the owner's word, and a test that it is never sent (`assert_metadata_only` in `tests/conftest.py`).
- **Never read, print or copy a `.env`, Claude Code's credentials (`~/.claude/.credentials.json`) or a key.** A test, a fixture or a commit never holds a real key.
- **Ask first:** any dependency change (the script's header, `pyproject.toml`, `uv.lock`) and any external-state change (a listing in a directory, a call to a live Telmoni with a real key).
- **Quality gate:** never weaken a test or leave the tree broken.
- **The hook never fails the session**: every fault is a log line and exit code 0.

## Where Things Live
| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | The manifest: name `telmoni-observability`, the version, the two settings (`TELMONI_API_KEY`, sensitive; `TELMONI_ENDPOINT`). |
| `.claude-plugin/marketplace.json` | The marketplace, `telmoni-plugins`, naming this repository (`./`) as the plugin. |
| `hooks/hooks.json` | `Stop`, `StopFailure` and `SessionEnd`, each running the script through uv or `python3`. |
| `hooks/telmoni_hook.py` | The script Claude Code runs, with the SDK in its header; it starts the worker and returns. |
| `hooks/telmoni_claude/` | The package: `payload` (the hook's input), `settings`, `transcript` (rows and what is read of them), `turns` (how turns are cut and when they are complete), `record` (a turn as a run), `send` (the SDK, and what its warnings mean), `state` (the session's file and lock), `worker`, `log`. |
| `tests/` | pytest: `conftest.py` writes transcripts as Claude Code does and stands in for Telmoni; `test_worker.py` runs the hook end to end, the SDK included. |
| `pyproject.toml`, `uv.lock` | The development tools alone (ruff, pytest), locked; the hook's one dependency is the script's header. |
| `.github/workflows/` | `ci.yml`: the suite on Python 3.10 and 3.14, ruff, a smoke run of the hook, the manifests, and the workflows themselves under actionlint. `release.yml`: on `main`, tags a version bump and cuts the release once the owner approves the `release` environment. |
| `ARCHITECTURE.md` | How it runs, what it reads, how turns are cut, what it sends, delivery, state, what ships, decisions. |
| [`telmoni/telmoni`](https://github.com/telmoni/telmoni) | Sibling repo, checked out as `../telmoni`: the SDK (`sdk/python`, `record_run`). |
| [`telmoni/docs`](https://github.com/telmoni/docs) | Sibling repo, checked out as `../docs`: the book; `content/api/coding-agents.mdx` is this plugin's page. |

## Commands
- **After every change** (no permission needed; report failures verbatim): `make check` — ruff, the suite, and `claude plugin validate --strict` on the plugin and the marketplace.
- `make fmt` formats; `make test` runs the suite alone. The suite runs the SDK against a fake Telmoni and needs no network once `uv sync --group dev` has run.
- **Only when asked:** a run against a live Telmoni, `uv lock --upgrade`, a version bump.

## Code Rules
- Python 3.10 or later, the floor the SDK sets; no dependency but the SDK in the script's header, and none in the package.
- A transcript row is read through `transcript.py`'s functions alone; a new field read is named there, with its test.
- Timestamps carry their zone; every record the SDK takes is built in `send.py` from the plain record `record.py` makes, which is what the state file keeps.
- Comments are for a person reading the code, and short: they say *why*, never *what* — a doc comment in a line or two, an inline comment in one, a test's name saying what it proves. The reasoning behind a change goes in `ARCHITECTURE.md` or the commit message, never above a function.
- No AI signatures anywhere.

## Git Rules
- Commit only when asked. Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) of 1–5 lines, signed off by the developer (`git commit -s`); no file lists, no `Co-authored-by` trailers.
- A release is the version bumped in `.claude-plugin/plugin.json` and `pyproject.toml` in one commit on `main`, which CI tags and releases on the owner's approval; never a tag by hand.
- No branches, worktrees, pushes or pull requests unless asked.

## Definition of Done
- [ ] `make check` passes, or the failure is reported verbatim.
- [ ] Nothing of a session reaches an export, the state, the log, a test fixture or a commit.
- [ ] `ARCHITECTURE.md` and the README say what changed; the book's `content/api/coding-agents.mdx` is fixed or named.
- [ ] Nothing that needs asking happened unasked.
