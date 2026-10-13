# Architecture

How the Claude Code plugin records a session, and why it is built so. What a person installs and sees is the book's page, [telmoni.com/docs/api/coding-agents](https://telmoni.com/docs/api/coding-agents).

## The shape

```
Claude Code ──(Stop, StopFailure, SessionEnd)──▶ node dist/hook.mjs
                                                     │ reads stdin, starts a detached copy, exits 0
                                                     ▼
                                       the copy: waits 1.5 s, takes the session's lock,
                                       reads the transcript from its saved offset,
                                       cuts it into turns, and for each that has ended:
                                       RunRecord ──▶ the SDK's recordRun ──▶ POST /otlp/v1/traces
                                       then saves the offset past that turn
```

A turn of the agent is a run of `claude-code`; the session's id is the run's session, so a session reads in the console as a session of traces. Each reply of the model is a model call, each tool a tool call, each subagent a step holding the subagent's own calls, and the skills a turn ran its tag `skills`. Claude Code's own OpenTelemetry export is not read: its traces are a beta, its token counts sit outside the GenAI conventions, and every span carries the person's email.

## A hook that never holds the session

Claude Code waits for its hooks, and gives `SessionEnd`'s all of 1.5 seconds together. The hook reads its input — the event, the session's id and the transcript's path, nothing else — and starts a copy of itself, detached and with no stdio, handing it that input in its environment rather than its command line, which anyone on the machine can list. Then it exits 0 having printed nothing — exit 2, or a decision on stdout, would keep Claude working — so a slow network or a Telmoni that does not answer never slows a turn. Whatever goes wrong after is a line in `hook.log`, never an error the session shows.

It runs at `Stop`, which Claude Code fires once each response is finished; at `StopFailure`, which it fires in `Stop`'s place when an API error ends the turn; and at `SessionEnd`. An interrupted turn fires none of them, and is sent by the next hook. `SubagentStop` is not used: the turn it falls in is still going.

## Reading a transcript

A transcript is JSON Lines that Claude Code appends as the session goes, and writes behind the conversation: at `Stop` its last lines may not be there yet, so a turn that has not ended as read is read again two seconds on before it is left to the next hook. The copy reads only whole lines from the session's saved offset: a last line without its newline is still being written, and waits for the next hook. It reads at most 16 MiB a hook: a long session's transcript runs to hundreds of megabytes (one of 485 MB, read here, caught up in 33 hooks and 12 seconds), so a plugin installed midway catches up a window at a time, and a window that ends before the file does never closes its last turn, which the window may have cut — unless that turn is all the window holds, when it goes a window at a time. A line longer than a window is passed over as an unreadable one is.

Claude Code can also write a session's old lines into its transcript again, ids and all — some long sessions run by the Agent SDK hold tens of thousands — and an opt-in cleanup can shrink the file. A line is read once by its id; a file smaller than the saved offset is read from the top; and the state keeps the runs sent (the last 5,000) and the time of the session's last line sent, so a turn read a second time is known by its run id, and lines that open no turn by being no later than that time.

**Turns.** A turn opens at the entry Claude Code marks with `turnPosition`: a prompt, a scheduled prompt, or a background task's notice. A compaction's summary carries the mark too, and is no opening, so a turn compacted midway stays one run. A transcript from before the marks is read by its prompts: a person's text or image, never a command's output, a notice, an interruption or a summary. The state remembers that a session is marked, since a read that begins inside a turn may hold no mark.

**When a turn has ended.** A turn has ended once the next one opens; at `Stop` and `StopFailure`, also once its last reply ended the turn rather than asking for a tool, or the person interrupted it; at `SessionEnd`, whatever was left. If another plugin's `Stop` hook keeps a turn going after this one sent it, the work after is read as a continuation — a segment with no opening — and sent as a run of its own, rather than the sent turn sent again, which ingest would store twice.

**What is read.** Of each entry: its kind, id, time and flags. Of a reply: its id, model, stop reason and token counts; a reply written over several lines, one per block, as Claude Code writes one, is one model call, its counts the last line's — every line repeats them, and in a subagent's transcript the earlier lines hold the counts so far. Of a tool call: its id and name, and of the `Skill` tool the skill's name. Of a tool's result: whether it was an error. Of a prompt: whether it opens with a tag or an interruption's marker. A subagent's own transcript sits beside the session's (`<session>/subagents/agent-*.jsonl`), found by the tool call its `.meta.json` names, whose `agentType` names the step; a nested subagent's calls join its parent's step. Claude Code's synthetic replies — an API error written in the model's place — are no model call; one that ends a turn fails the run with its error's kind (`rate_limit`).

**Tokens.** Claude Code counts input apart from the cache's reads and writes; the SDK takes input as the GenAI conventions do, so a call's input is the three summed, with the cache's two also given apart.

**Times.** A model call starts when the entry before its first line was written — the prompt, or the last tool's result — and ends with its last line; a tool call runs from the reply that asked for it to its result; an unanswered one, cut off by an interruption or the session's end, is cancelled and ends with the turn.

## Ids, and sending each turn once

A run's id is a version 5 UUID of the session's id and the turn's first entry's id, under the plugin's own namespace, so a turn read twice is the same run. The SDK derives every span's id from the run's id and its place in the record, and queues a record in one synchronous pass, so the same turn sent again is the same bytes; ingest's claim on a body answers a second copy as it answered the first, for an hour.

Each turn goes in an export of its own, flushed before the next, and the offset is saved past it once the SDK reports no warning: a turn the platform took is never sent again, and one it did not is sent by the next hook, from the same offset. A turn the SDK itself refuses — an impossible time — is logged and passed over, since it would be refused on every hook.

A lock per session (`<session>.lock`, a lock older than two minutes taken as left by a hook that died) keeps a `Stop` and a `SessionEnd` from sending the same turns at once; a hook that waits a minute without it gives up, and the next hook sends.

## Where things are kept

Beside the configuration folder Claude Code runs with (`CLAUDE_CONFIG_DIR`, `~/.claude` by default), in `telmoni/`: `<session>.json` (the offset, the runs sent and the last time sent, whether the transcript is marked, whether a missing key was logged), the locks, and `hook.log`, moved to `hook.log.1` past a megabyte. All of it mode `600` in a folder of mode `700`. Claude Code's own `CLAUDE_PLUGIN_DATA` folder would survive an update as well, but is named by the plugin's identity, and a person looking for the log finds `~/.claude/telmoni/` at once.

The key and the endpoint are the plugin's user configuration — Claude Code keeps the key, marked sensitive, with its own credentials (the Keychain on macOS, its credentials file elsewhere) and hands a hook both as `CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY` and `CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT` — or, unset, the SDKs' own `TELMONI_API_KEY` and `TELMONI_ENDPOINT`. Without a key nothing is sent, and the log says so once per session. The provider is `anthropic`, or `aws.bedrock` and `gcp.vertex_ai` where Claude Code runs on those (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`).

## Cursor

Cursor runs Claude Code's hooks too, an installed plugin's among them, handing them its own events. A hook whose input carries `cursor_version`, or that runs with `CURSOR_VERSION` set, does nothing and logs nothing: Telmoni's Cursor plugin records those sessions.

## What ships

The npm package `telmoni-claude-observability-plugin` holds `.claude-plugin/plugin.json`, `hooks/hooks.json` and `dist/hook.mjs` — tsup's one bundle of the plugin, the SDK and OpenTelemetry — beside `package.json`, `README.md` and `LICENSE`, which npm always adds. Claude Code fetches it with the person's own npm (`npm view`, then `npm pack --ignore-scripts`, its integrity checked) and runs none of its scripts; it installs a package's dependencies only from a shrinkwrap, which this one, with none, does not ship. The hook needs Node 22 or later on `PATH`, and nothing installed. `plugin.json`'s `version` is the package's, bumped with every release: an npm plugin without one is never updated. The marketplace is this repository's `.claude-plugin/marketplace.json`, added with `--sparse .claude-plugin`, so an install fetches the two manifests and the repository's root files, never `src/` or `tests/`.

Until the SDKs are published, the SDK is a development dependency by path (`file:../telmoni/sdk/typescript`), bundled at build; publishing this package waits on theirs, and the dependency becomes the registry's `telmoni` in the same change.

## Testing

`tests/` runs the parser and the record over recorded sessions (`tests/fixtures/`), scrubbed to the fields the plugin reads, every text replaced, every id renamed and every time shifted; the session's hook against a fake sender, an appended transcript and a sender that fails; the sender through the real SDK to a fake ingest; and the built hook as Claude Code runs it, a process handed its input on stdin that must exit at once while its copy sends.
