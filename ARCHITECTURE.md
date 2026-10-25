# Architecture

The Claude Code plugin for Telmoni: a hook that records each turn of a person's Claude Code sessions as a run, metadata only, through the Python SDK of the platform ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/python`). The repository is the plugin: its marketplace names itself, Claude Code clones it, and the hook runs from the clone as a uv script, so there is nothing to build, package or publish.

## How it runs

Claude Code runs `hooks/telmoni_hook.py` at `Stop`, at `StopFailure` and at `SessionEnd`, through `uv run --script` or, without uv, `python3`. The script reads the event from stdin, keeps only what names the work (the session id, the transcript's path, the event, an API error's kind, whether a background subagent still runs) and starts a worker: the same script with `--work`, given the event by its stdin, in a session of its own, its output to the log. It returns at once, so a turn never waits on Telmoni and a session's end, which gives its hooks a second and a half, never loses one. The hook's command exits 0 whatever uv or python3 return: a `Stop` hook's exit 2 sends Claude back to work, and uv's first fetch of the SDK fails where there is no network. The worker takes a lock on the session, waits for the transcript to stop growing, reads the rows written since the last hook, sends each turn that has ended, and remembers the rest.

Cursor runs Claude Code's hooks too; it names itself in the environment and in its payload, and the hook does nothing there, Cursor's own plugin recording those conversations.

## What it reads

A transcript is JSON Lines. Of each row the plugin reads its kind, its ids, its time, its counts and its flags: a reply's model, message id and token usage; a tool call's id and name, a skill's name and a subagent's kind from a `Skill` or `Agent` call's input, and nothing else of any input; a tool result's id, whether it failed and whether the person stopped it; the flags that mark Claude Code's own rows (`isMeta`, `isCompactSummary`, `turnCompanion`, `isSidechain`, `isApiErrorMessage`), the kind of a row's `origin` (the person, a task's notice, a peer) and an API error's kind. Of a user row's text it reads the first characters, for the markers Claude Code writes there, an interruption, a task's notice, a command's output, and the tool-use id inside a notice; of an image, that there is one. Nothing of that text is kept. A subagent's transcript, beside the session's under `subagents/`, is read the same way, found by the tool call that started it.

## How turns are cut

A prompt the person gave opens a turn and closes the one before it. Replies attach to the open turn, the rows of one message merged into one model call that runs from the event before it; tool calls open at their reply and close at their result, failed where the result says so, cancelled where the person stopped or refused them or where no result ever came. An interruption marker ends the turn cancelled unless a reply follows it. A task's notice marks the background subagent it answers, in whichever turn it lands, and the reply after it says the session went on.

A turn is complete, and sent, when nothing can still change it: a subagent started in the background has had its notice and the reply to it, every subagent of the turn has finished, and the session reports no background subagent while the turn is the last one. The session's end sends every turn as it stands. Rows copied from another session, as a fork copies its history, are passed over: that session recorded them.

## What it sends

One run a turn, through `record_run`: its id derived from the session and the prompt, so a turn sent twice is stored once; the agent `claude-code`; the session as the run's session; the run from the prompt to the last reply, result or interruption; `release` the version of Claude Code that wrote the transcript; the tag `skills` when the turn ran any. Inside the run, each model call with its provider, model and usage, each tool call by name, and each subagent as a step named `subagent <kind>` holding the subagent's own calls. A turn an API error ended fails as that error's kind, as does the reply that met it; a turn the hook's `StopFailure` names an error for, with no such reply in the transcript yet, fails as the hook's.

## Delivery

Each run gets an SDK client of its own, so the SDK's once-per-client warnings are the run's. A flush waits out the SDK's worst case, 30 seconds and 150 a batch of 512 spans, then the warnings decide: a refusal for what the run holds (`400`, `413`), for the organization's standing (`402`) or for a fault of Telmoni's own (`500`, except its database failing) is final and logged; anything else, Telmoni out of reach or busy, its database down, the key or the endpoint refused, keeps the run, which is sent again before any new one as the session's next hook runs, the later turns waiting behind it; the newest 200 such runs are kept, and the log says how many went past that. A run the server took in part is logged as such. A run with more spans than the SDK's queue holds is logged and dropped; the SDK caps the queue at 2,048 spans and takes no other size yet.

## State

The plugin's folder is the one Claude Code keeps for it across updates, `CLAUDE_PLUGIN_DATA`, else `telmoni` under Claude Code's config folder. In it, a file a session holds the byte offset where the first turn not yet sent begins, the ids of the runs sent, the runs Telmoni could not take yet, and which warnings were given; a transcript replaced under it is read from its start. A lock a session is held through the operating system by the worker at work on it, so a holder that dies lets go of it, whatever becomes of its pid; a `Stop` waits a minute for a live one, and the session's end waits it out. The log, `hook.log`, holds one line a failure or a run sent, naming the session by the start of its id.

## What ships

Everything an install needs is in the repository: the manifest, the hooks file, the script and its package. The marketplace entry's source is `./`, so Claude Code takes the repository at its head and `claude plugin update` takes the next. A release is the version bumped in `.claude-plugin/plugin.json` and `pyproject.toml` in one commit on `main`; CI tags it and cuts the GitHub release once the owner approves the `release` environment. The SDK is fetched on a machine as the hook first runs, from the script's own header, into uv's cache; the development tools alone are locked, in `uv.lock`.

## Decisions

- **Python, run from source, no package.** A hook that needs no build needs no artifact to publish or keep in step: the repository is what runs. Claude Code cannot install an npm source at all, and a branch of built files was one more thing to maintain. The other Telmoni plugins stay TypeScript on npm, where that works.
- **Metadata only, by construction.** Nothing of what is said in a session is held in any value the plugin builds; the tests send a transcript full of marked phrases and assert that none reaches an export, the state or the log.
- **A detached worker.** Claude Code waits for a `Stop` hook and gives a `SessionEnd` hook a second and a half; the sending, which may wait minutes on a slow Telmoni, happens where neither is held up. The event reaches the worker by its stdin: a process's arguments are shown to everyone on the machine, and the event names the transcript.
- **The turn as the unit, held until it cannot change.** A run sent is stored once, so a turn is sent when complete rather than amended; a background subagent keeps its turn waiting until its notice is answered.
