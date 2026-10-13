# Telmoni for Claude Code

Records each turn of your [Claude Code](https://code.claude.com) sessions in [Telmoni](https://telmoni.com) as a run: the models it called and their tokens, the tools it used, the subagents it started and the skills it ran, each with its times and whether it failed. Never a prompt, a reply, a thought, a tool's input or output, a file's path or the folder you work in.

## Install

You need Claude Code, and Node.js 22 or later with npm on your `PATH`: Claude Code installs the plugin's npm package with your npm, and the hook runs on your Node.

```sh
claude plugin marketplace add telmoni/claude-observability-plugin --sparse .claude-plugin
claude plugin install telmoni-observability@telmoni-plugins
```

The marketplace is added sparse, so only its manifest is fetched; the plugin itself is the npm package [`telmoni-claude-observability-plugin`](https://www.npmjs.com/package/telmoni-claude-observability-plugin), its built hook alone.

## Configure

Make a project API key holding the **ingest** scope on your project's API keys page, then, in a Claude Code session, run:

```text
/plugin configure telmoni-observability@telmoni-plugins
```

and paste the key where it asks: the field is masked. From your shell, `claude plugin configure telmoni-observability@telmoni-plugins --values-stdin` takes the values as JSON on its input instead (`{"TELMONI_API_KEY": "telmoni_…"}`); without `--values-stdin` it only lists them.

Claude Code keeps the key with its own credentials: in the Keychain on macOS, and in its credentials file elsewhere. Left blank, the endpoint is `https://api.telmoni.com`; a self-hosted Telmoni gives its own machine host. `TELMONI_API_KEY` and `TELMONI_ENDPOINT` in the environment serve when the plugin's own settings are unset.

Start a new session: plugins load as a session starts.

## What it records

Each turn — from your prompt to Claude's last reply, or to your interruption — is a run of the agent `claude-code`, and your session is its session, so the console shows a session as a session of traces. Inside the run:

- each reply of the model, a model call with its model and its token counts, the cache's reads and writes among them;
- each tool call, by its name, with its time, and failed where the tool answered with an error;
- each subagent, a step named by its kind (`subagent Explore`) holding its own model and tool calls;
- the skills the turn ran, by name, as the tag `skills`.

A turn is sent once it has ended — one that started a subagent in the background, once that subagent has finished too, so its step holds all of the subagent's work. If Telmoni cannot be reached, the next turn's hook sends it, and a turn sent again is the same bytes, which Telmoni stores once.

## When something is wrong

The hook never slows or interrupts a session: it hands its work to a detached process and exits at once. Anything that went wrong is a line in `~/.claude/telmoni/hook.log` (beside `CLAUDE_CONFIG_DIR` where you set one), naming what kind of thing went wrong and never anything from your session.

## Uninstall

```sh
claude plugin uninstall telmoni-observability@telmoni-plugins
```

Then delete `~/.claude/telmoni/`, the plugin's record of what it sent.

## License

Apache-2.0
