# Architecture

The Claude Code plugin for Telmoni: a hook that records each turn of a person's Claude Code sessions as a run, metadata only, through the platform's Python SDK ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/python`). The repository is the plugin: its marketplace names itself, Claude Code clones it, and the hook runs from the clone as a uv script. There is nothing to build, package or publish.

## How it runs

Claude Code runs `hooks/telmoni_hook.py` at `Stop`, `StopFailure` and `SessionEnd`, through `uv run --script` or, without uv, `python3`. The script reads the event from stdin and keeps only what names the work: the session id, the transcript's path, the event, an API error's kind, and whether a background task (a subagent, a workflow, a teammate) still runs. It starts a worker, the same script with `--work`, in a session of its own, handing it the event over stdin, its errors going to the log, and returns at once: a turn never waits on Telmoni, and a session's end loses nothing. The hook's command exits 0 whatever uv or python3 return, since a `Stop` hook's exit 2 would send Claude back to work, and uv's first fetch of the SDK fails without a network.

The worker reads the settings and, without a key, logs that once and stops. Otherwise it takes a lock on the session, waits for the transcript to stop growing, reads the rows written since the last hook, sends each turn that has ended, and remembers the rest.

Cursor runs Claude Code's hooks too; it names itself in the environment and in its payload, and the hook does nothing there, Cursor's own plugin recording those conversations.

## What it reads

A transcript is JSON Lines. Of each row the plugin reads its kind, ids, time, counts and flags:

- of a reply, its model, message id and token usage, and an API error's kind;
- of a tool call, its id and name; of its input, a skill's name from a `Skill` call, and a subagent's kind and whether it was to run in the background from an `Agent` or `Task` call, and nothing else;
- of a tool result, its id, whether it failed, whether the person stopped it, and whether it says a subagent went on in the background;
- the flags that mark Claude Code's own rows (`isMeta`, `isCompactSummary`, `turnCompanion`, `isSidechain`, `isApiErrorMessage`), the kind of a row's `origin` (the person, a task's notice, a peer), and the session a row belongs to;
- of a user row's text, its first characters, for the markers Claude Code writes there (an interruption, a task's notice, a command's output, injected context) and the tool-use id a notice names; of an image, that there is one. Nothing of that text is kept.

Names are kept as plain names within ingest's caps (`names.py`): a model named by a path goes as its weights file's name, or `unknown`, and is cut to 128 characters; a tool's name, a skill's or a subagent's kind holding anything but a plain name, as a model may write, goes as `unknown`, or not at all.

A subagent's transcript, in the session's folder under `subagents/`, is read the same way; its `.meta.json` names the tool call that started it, its kind and whether it has finished.

## How turns are cut

A prompt the person gave opens a turn and closes the one before it. Replies attach to the open turn, the rows of one message merged into one model call timed from the event before it. Tool calls open at their reply and close at their result: failed where the result says so, cancelled where the person stopped or refused them or no result ever came. An interruption marker ends the turn cancelled unless a reply follows it. A task's notice marks the background subagent it answers, in whichever turn it lands, and the reply after it says the session went on.

A turn is complete, and sent, when nothing can still change it: every subagent it started in the background has had its notice and the reply to it, every subagent it ran has finished, and, if it is the last turn, the session reports no background task. The session's end sends every turn as it stands. A turn with no reply and no tool call is passed over, as are rows copied from another session, the way a fork copies its history: that session recorded them.

## What it sends

One run a turn, through `record_run`. Its id derives from the session and the prompt, so a turn sent twice is stored once. It carries the agent `claude-code`, the session, the span from the prompt to the last reply, result or interruption, `release` as the version of Claude Code that wrote the transcript, and the tag `skills` naming the skills the turn ran, if any. Inside it, each model call with its provider, model and usage, the provider as the GenAI conventions and the price table name it (`aws.bedrock`, `gcp.vertex_ai` or `azure.ai.inference` where Claude Code's `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX` or `_FOUNDRY` is set, else `anthropic`), its input counting the cache's reads and writes as the conventions do, where Anthropic's own count leaves them out; each tool call by name; and each subagent as a step named `subagent <kind>` holding the subagent's own calls. A turn an interruption ended is cancelled, as is a call never answered. A turn an API error ended fails as that error's kind, as does the reply that met it; a turn the hook's `StopFailure` names an error for, with no such reply in the transcript yet, fails as the hook's.

## Delivery

Each run gets an SDK client of its own, so the SDK's once-per-client warnings are the run's. A flush waits out the SDK's worst case, 30 seconds plus 150 a batch of 512 spans, then the warnings decide. A refusal for what the run holds (`400`, `413`), for the organization's standing (`402`) or for a fault of Telmoni's own (`500`, unless its database failed) is final and logged. Anything else, Telmoni out of reach or busy, its database down, the key or the endpoint refused, keeps the run: it is sent again before any new one at the session's next hook, the later turns waiting behind it, and, since a session's last hook has no next one, by the next hook of any session that reached Telmoni: once its own work is done, it sends what other sessions left, oldest first, each under that session's lock taken without waiting, and stops at the first run still not delivered. A `.pending` file beside each state that still holds runs keeps that look cheap. The newest 200 such runs are kept, and the log says how many went past that. A run sent in several batches, one refused and another not delivered, is kept, as the other plugins keep it. A kept run that no longer builds, written by an older version of the plugin, is dropped and logged, so the session's later runs still go. A run the server took in part is logged as such. A run with more spans than the SDK's queue holds, 2,048, is logged and dropped; the SDK takes no other size yet.

## State

The plugin's folder is the one Claude Code keeps for it across updates, `CLAUDE_PLUGIN_DATA`, else `telmoni` under Claude Code's config folder. In it, one file a session holds the byte offset where the first turn not yet sent begins, the ids of the newest 500 runs sent, the runs Telmoni could not take yet, and which warnings were given; a transcript replaced under it is read from its start. The file is saved as each run is sent, refused or kept, at most once a second, and always at the end, written aside, synced and renamed over the last, readable by its owner alone, so a worker killed partway, or a power cut, sends nothing twice. A file that cannot be read is left as it is and the session sends nothing, logged: read as new, it would send the whole session again and lose its kept runs. One lock a session is held through the operating system by the worker at work on it, so a holder that dies lets go of it, whatever becomes of its pid; a `Stop` or `StopFailure` waits a minute for a live one, and the session's end waits it out. The log, `hook.log`, holds one line a failure or a run sent, naming the session by the start of its id, and is turned over at a mebibyte.

## What ships

Everything an install needs is in the repository: the manifest, the hooks file, the script and its package. The marketplace entry's source is `./`, so an install copies the repository at its head, and Claude Code names the copy by the manifest's version: `claude plugin update` replaces it only when that string changes, so a commit without a bump reaches no one installed. A release is the version bumped in `.claude-plugin/plugin.json` and `pyproject.toml` in one commit on `main`; once CI passes and the owner approves the `release` environment, CI tags it and cuts the GitHub release. The SDK is fetched on a machine as the hook first runs, from the script's own header, into uv's cache; the development tools alone are locked, in `uv.lock`.

## Decisions

- **Python, run from source, no package.** A hook that needs no build needs no artifact to publish or keep in step: the repository is what runs. Claude Code copies a plugin as it finds it and never builds one, so a TypeScript hook from git had to commit its built files, a branch to keep in step with every release; and an npm source, which Claude Code fetches with `npm pack`, is refused by the npm of October 2026's Node releases, whose `allow-remote` defaults to `none`. The other Telmoni plugins stay TypeScript on npm, where that works.
- **Metadata only, by construction.** Nothing said in a session is held in any value the plugin builds; the tests send a transcript full of marked phrases and assert that none reaches an export, the state or the log.
- **A detached worker.** Claude Code waits for a `Stop` hook and gives `SessionEnd` hooks a second and a half between them; the sending, which may wait minutes on a slow Telmoni, happens where neither is held up. The event reaches the worker by its stdin, as a process's arguments are shown to everyone on the machine and the event names the transcript.
- **The turn as the unit, held until it cannot change.** A run sent is stored once, so a turn is sent when complete rather than amended; a background subagent keeps its turn waiting until its notice is answered.
