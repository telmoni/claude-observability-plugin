# Architecture

How the Claude Code plugin records a session, and why it is built so. What a person installs and sees is the book's page, [telmoni.com/docs/api/coding-agents](https://telmoni.com/docs/api/coding-agents).

## The shape

```
Claude Code ──(Stop, StopFailure, SessionEnd)──▶ node dist/hook.mjs
                                                     │ reads stdin, starts a detached copy, exits 0
                                                     ▼
                                       the copy: waits 1.5 s, takes the session's lock,
                                       reads the transcript from its saved offset,
                                       cuts it into turns, and for each that has ended
                                       and waits on no subagent still at work:
                                       RunRecord ──▶ the SDK's recordRun ──▶ POST /otlp/v1/traces
                                       then saves the offset past that turn
```

A turn of the agent is a run of `claude-code`; the session's id is the run's session, so a session reads in the console as a session of traces. Each reply of the model is a model call, each tool a tool call, each subagent a step holding the subagent's own calls, and the skills a turn ran its tag `skills`. Claude Code's own OpenTelemetry export is not read: its traces are a beta, its token counts sit outside the GenAI conventions, and every span carries the person's email.

## A hook that never holds the session

Claude Code waits for its hooks, and gives `SessionEnd`'s all of 1.5 seconds together. It starts this one as `node` with the hook's path as its one argument, no shell between them, so a path with a space in it, or Windows' shells, change nothing. The hook reads its input — the event, the session's id and the transcript's path, nothing else — and starts a copy of itself, detached and with no stdio, handing it that input in its environment rather than its command line, which anyone on the machine can list. Then it exits 0 having printed nothing — exit 2, or a decision on stdout, would keep Claude working — so a slow network or a Telmoni that does not answer never slows a turn; an input that never ends is given up after five seconds. Whatever goes wrong after is a line in `hook.log`, never an error the session shows.

It runs at `Stop`, which Claude Code fires once each response is finished; at `StopFailure`, which it fires in `Stop`'s place when an API error ends the turn; and at `SessionEnd`. An interrupted turn fires none of them, and is sent by the next hook. `SubagentStop` is not used: the turn it falls in is still going.

## Reading a transcript

A transcript is JSON Lines that Claude Code appends as the session goes, and writes behind the conversation: at `Stop` its last lines may not be there yet, so a turn that has not ended as read is read again two seconds on before it is left to the next hook. The copy reads only whole lines from the session's saved offset: a last line without its newline is still being written, and waits for the next hook. Each line is cut down to the fields below as it is parsed, a megabyte of the file in memory at a time, so nothing said in the session is held past its own line and a long turn is held in a few megabytes.

It reads 16 MiB a hook: a long session's transcript runs to hundreds of megabytes (one of 485 MB, read here, caught up in 33 hooks and 12 seconds; a synthetic one of 684 MB, with 60,705 old rows written again, in 47 hooks and 8 seconds, each of its 2,340 turns once), so a plugin installed midway catches up a window at a time, and a window that ends before the file does never closes its last turn, which the window may have cut. A turn longer than a window is read whole, the window doubled until it holds the next turn's opening, up to 256 MiB; only past that does a turn go in parts, each a run. `SessionEnd`, after which no hook comes, reads on, a window at a time, to the file's end. A line longer than a window is passed over as an unreadable one is.

Claude Code can also write a session's old lines into its transcript again, ids and all — some long sessions run by the Agent SDK hold tens of thousands — and an opt-in cleanup can shrink the file. A line is read once by its id; a file smaller than the saved offset, or one in which the line before the offset is not the one that was there when it was saved — its id, or its kind where it has none, is kept beside the offset — is read from the top; and the state keeps the runs sent (the last 5,000) and the time of the session's last line sent, so a turn read a second time is known by its run id, and lines that open no turn by being no later than that time.

**Turns.** A turn opens at the entry Claude Code marks with `turnPosition`: a prompt, a scheduled prompt, or a background task's notice. A compaction's summary carries the mark too, and is no opening, so a turn compacted midway stays one run. A transcript from before the marks is read by its prompts: a person's text or image, never a command's output, a notice, an interruption or a summary. The state remembers that a session is marked, since a read that begins inside a turn may hold no mark.

**When a turn has ended.** A turn has ended once the next one opens; at `Stop` and `StopFailure`, also once its last reply ended the turn rather than asking for a tool or pausing for one the API runs itself, or the person interrupted it; at `SessionEnd`, whatever was left. If another plugin's `Stop` hook keeps a turn going after this one sent it, the work after is read as a continuation — a segment with no opening — and sent as a run of its own, rather than the sent turn sent again, which ingest would store twice.

**A subagent at work in the background.** A subagent started in the background answers its tool call at once and works on after the turn that started it has stopped, often for many minutes. That turn, and the turns after it, are held until the subagent's transcript shows its run ended — the notice it then sends opens a turn whose `Stop` sends both — or until nothing has been written there for half an hour, so the step holds all of the subagent's work rather than what it had done by the turn's `Stop`. `SessionEnd` sends a held turn as it stands, the step cancelled. A subagent resumed in a later turn writes on in the same transcript; its step holds only the run the turn started.

**What is read.** Of each entry: its kind, id, time and flags. Of a reply: its id, model, stop reason and token counts; a reply written over several lines, one per block, as Claude Code writes one, is one model call, its counts the last line's — every line repeats them, and in a subagent's transcript the earlier lines hold the counts so far. Of a tool call: its id and name, and of the `Skill` tool the skill's name. Of a tool's result: whether it was an error. Of a prompt: whether it opens with a tag or an interruption's marker. A subagent's own transcript sits beside the session's (`<session>/subagents/agent-*.jsonl`), found by the tool call its `.meta.json` names, whose `agentType` names the step; a nested subagent's calls join its parent's step. Claude Code's synthetic replies — an API error written in the model's place — are no model call; one that ends a turn fails the run with its error's kind (`rate_limit`).

A tool's or a skill's name, and a model's id, leave only as Claude Code spells them — letters, digits and `_.:-`, a model's `@/[]` too — within the 128 characters the platform keeps of one: a skill's name is the model's own writing, in the `Skill` tool's input, and anything else could be words. A name out of that shape is sent as `unknown`, a skill's not at all; the tag `skills` holds as many names, whole and in order, as fit in the 256 characters the platform keeps of a tag, past which it would drop the tag.

**Tokens.** Claude Code counts input apart from the cache's reads and writes; the SDK takes input as the GenAI conventions do, so a call's input is the three summed, with the cache's two also given apart.

**Times.** A model call starts when the entry before its first line was written — the prompt, or the last tool's result — and ends with its last line; a tool call runs from the reply that asked for it to its result; an unanswered one, cut off by an interruption or the session's end, is cancelled and ends with the turn. Nothing starts before the run or the step it is part of, nor ends before it starts: Claude Code writes a prompt's attachments a few milliseconds before the prompt, and a clock may step back.

## Ids, and sending each turn once

A run's id is a version 5 UUID of the session's id and the turn's first entry's id, under the plugin's own namespace, so a turn read twice is the same run. The SDK derives every span's id from the run's id and its place in the record, and queues a record in one synchronous pass, so the same turn sent again is the same bytes; ingest's claim on a body answers a second copy as it answered the first, for an hour.

Each turn goes in an export of its own, flushed before the next, and the offset is saved past it once the SDK reports no warning but of what the platform kept it without — a span refused, an attribute dropped — which a copy would be answered with again: a turn the platform took is never sent again, and one it did not is sent by the next hook, from the same offset. The SDK queues the whole turn, however many spans it holds, and the flush may take three minutes, past the SDK's own worst case for an export, so a turn the platform took late is not counted as not sent and sent again after the hour for which ingest's claim answers a copy; past that hour the platform stores a copy as it stores anything new. A turn the SDK itself refuses — an impossible time — is logged and passed over, since it would be refused on every hook.

A lock per session (`<session>.lock`) keeps a `Stop` and a `SessionEnd` from sending the same turns at once; a hook that waits a minute without it gives up, and the next hook sends. Its hook touches it every half minute, so a lock untouched for two minutes was left by a hook that died, and is taken; it holds a token of its hook's, which lets go of its own lock and never of one another took from it after the machine slept.

## Where things are kept

Beside the configuration folder Claude Code runs with (`CLAUDE_CONFIG_DIR`, `~/.claude` by default), in `telmoni/`: `<session>.json` (the offset and the id or kind of the line before it, the runs sent and the last time sent, whether the transcript is marked, whether a missing key was logged), the locks, and `hook.log`, moved to `hook.log.1` past a megabyte. All of it mode `600` in a folder of mode `700`. Claude Code's own `CLAUDE_PLUGIN_DATA` folder would survive an update as well, but is named by the plugin's identity, and a person looking for the log finds `~/.claude/telmoni/` at once.

The key and the endpoint are the plugin's user configuration — Claude Code keeps the key, marked sensitive, with its own credentials (the Keychain on macOS, its credentials file elsewhere) and hands a hook both as `CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY` and `CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT` — or, unset, the SDKs' own `TELMONI_API_KEY` and `TELMONI_ENDPOINT`. Neither option has a default, which Claude Code could hand a hook as the option's own value, ahead of the SDKs' variables: an endpoint left blank is the SDK's, `https://api.telmoni.com`. Without a key nothing is sent, and the log says so once per session. The provider is `anthropic`, or `aws.bedrock` and `gcp.vertex_ai` where Claude Code runs on those (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`).

## Cursor

Cursor runs Claude Code's hooks too, an installed plugin's among them, handing them its own events. A hook whose input carries `cursor_version`, or that runs with `CURSOR_VERSION` set, does nothing and logs nothing: Telmoni's Cursor plugin records those sessions.

## What ships

The npm package `@telmoni/claude-observability-plugin` holds `.claude-plugin/plugin.json`, `hooks/hooks.json` and `dist/hook.mjs` — tsup's one bundle of the plugin, the SDK and OpenTelemetry — beside `package.json`, `README.md` and `LICENSE`, which npm always adds. Claude Code fetches it with the person's own npm (`npm view`, then `npm pack --ignore-scripts`, its integrity checked) and runs none of its scripts; it installs a package's dependencies only from a shrinkwrap, which this one, with none, does not ship. The hook needs Node 22 or later on `PATH` — the built hook runs on 22.0.0 — and nothing installed. `plugin.json`'s `version` is the package's, bumped with every release: an npm plugin without one is never updated. The marketplace is this repository's `.claude-plugin/marketplace.json`, as each of Langfuse's plugins is its own: it names the package, so Claude Code clones this repository for the catalog and fetches the plugin as built from npm, never a build of the clone.

**A release** is the version bumped in one commit on `main` — `package.json`, both of `package-lock.json`'s and `.claude-plugin/plugin.json`'s — and nothing else by hand. Its push starts `.github/workflows/release.yml`, which waits for CI to pass on that commit, verifies and packs the package as CI does, and waits for the owner's approval in its `release` environment: one job tags the commit `v*`, and another stages the package on npm by trusted publishing, with provenance, so no token is stored anywhere. The GitHub release follows, and the version goes live once the owner approves it in the package's *Staged Packages* tab on npmjs.com. `0.1.0` and `0.1.1` went up by hand, untagged, so the first release from CI is the next version.

The SDK is a development dependency, the registry's `telmoni`, bundled at build.

## Testing

`tests/` runs the parser and the record over recorded sessions (`tests/fixtures/`), scrubbed to the fields the plugin reads, every text replaced, every id renamed and every time shifted; the session's hook against a fake sender, over transcripts appended to, written again, shrunk, rewritten and longer than a window, and with a background subagent still at work; the sender through the real SDK to a fake ingest that fails, comes back, and takes a turn in part; the built hook as Claude Code runs it, a process handed its input on stdin that must exit before its copy sends, keeping what it keeps shut to all but its owner and nothing of the session on any command line; and the manifests and what npm would pack. The suites run one file at a time, since some time processes and timers. Each critical path — what is kept, the ids, the offsets, sending again, a turn's bounds — has been broken on purpose in a scratch copy, 37 ways, and a test failed each time.
