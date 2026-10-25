# Telmoni for Claude Code

Records each turn of your [Claude Code](https://code.claude.com) sessions in [Telmoni](https://telmoni.com) as a run: the models it called and their tokens, the tools it used and the subagents it started, each with its times and whether it failed. Never a prompt, a reply, a thought, a tool's input or output, a command, or a path.

## Install

You need Claude Code, git, and [uv](https://docs.astral.sh/uv/) on your `PATH`. Claude Code adds the marketplace and fetches the plugin with your git; the hook runs as a uv script, which installs the [Telmoni Python SDK](https://pypi.org/project/telmoni/) from the script's own header the first time it runs. Without uv, the hook falls back to `python3`, Python 3.10 or later, with the `telmoni` package installed for it.

```sh
claude plugin marketplace add telmoni/claude-observability-plugin
claude plugin install telmoni-observability@telmoni-plugins
```

This repository is the marketplace, and the plugin is the repository itself: an install takes it at its head, and `claude plugin update telmoni-observability@telmoni-plugins` takes the next one. Installed so, the plugin loads in every Claude Code you start: the terminal's, an editor's, the Agent SDK's. Plugins load as a session starts, so start a new one once it is installed and configured.

### From a checkout

```sh
git clone https://github.com/telmoni/claude-observability-plugin.git
TELMONI_API_KEY=tm_… claude --plugin-dir ./claude-observability-plugin
```

That one session runs the plugin as cloned; there is nothing to build.

## Configure

The plugin asks for a [project API key](https://telmoni.com/docs/api/api-keys) holding the **ingest** scope as it is installed. Set or change it in a session with `/plugin configure telmoni-observability@telmoni-plugins`, or from your shell:

```sh
echo '{"TELMONI_API_KEY": "tm_…"}' | claude plugin configure telmoni-observability@telmoni-plugins --values-stdin
```

Claude Code keeps the key with its own credentials: in the Keychain on macOS, and in its credentials file elsewhere. The endpoint is `https://api.telmoni.com` unless you set one; a self-hosted Telmoni gives its machine host. `TELMONI_API_KEY` and `TELMONI_ENDPOINT` in the environment Claude Code starts in — your shell's, or a repository's `.claude/settings.json` `env` block — come before the plugin's own settings, so one checkout can report to another project.

## What a turn records

A turn, from your prompt to the agent's last reply or to your interruption, is one run of the agent `claude-code`, in your session. Inside it: a model call per reply, with its model and its token counts, the cache's reads and writes among them; each tool call by its name, with its time, failed where the tool failed and cancelled where you stopped or refused it; each subagent as a step named by its kind, holding the subagent's own model and tool calls; and the skills the turn ran, by name, as the tag `skills`. An interrupted turn is a cancelled run; a turn an API error ended is a failed one, named by the error's kind (`rate_limit`), never its message. A turn that started a subagent in the background is sent once the subagent's notice has been answered.

Of what Claude Code writes down, the plugin reads only kinds, ids, times, counts and flags, and the first characters of a user row for the markers Claude Code puts there: an interruption, a task's notice, a command's output. It never keeps or sends a prompt or a reply, the model's thinking, a tool's input or output beyond a skill's name, a command, a file's path or contents, the folder you work in, a session's title or anyone's email.

## When nothing shows up

The hook runs when a turn stops, when an API error ends one, and when the session ends, and hands the work to a process of its own, so no turn waits on Telmoni. Its log is `hook.log` in the plugin's data folder: `~/.claude/plugins/data/telmoni-observability-telmoni-plugins/` for an install from the marketplace, `~/.claude/plugins/data/telmoni-observability-inline/` under `--plugin-dir`, or `~/.claude/telmoni/` where Claude Code gives the plugin no data folder. One line names each failure by the start of the session's id: no key, an endpoint the SDK refused, a turn Telmoni could not take, which is kept, the newest 200 of them, and sent again as the next turn ends, or one it refused for good, which is not. The hook itself never fails a turn: where uv cannot fetch the SDK the first time, with no network, it does nothing that turn and tries again at the next. Inside Cursor, which runs Claude Code's hooks too, the plugin does nothing: Cursor's own plugin records those conversations.

## Developing

```sh
make check    # ruff, pytest, and the manifests as Claude Code validates them
```

A release is the version bumped in `.claude-plugin/plugin.json` and `pyproject.toml` in one commit on `main`; CI tags it and cuts the GitHub release once the owner approves.

## License

Apache-2.0.
