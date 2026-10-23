/**
 * One hook's work on one session: the turns that have ended since the last
 * hook sent, each sent as a run, and the place they end saved after each, so
 * a turn is sent once and none is skipped.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RunRecord } from 'telmoni';

import { type Context, type Subagent, recordOf, subagentsIn } from './record.js';
import type { Destination } from './send.js';
import type { Settings } from './settings.js';
import { type SessionState, readState, withLock, writeState } from './state.js';
import {
  type Entry,
  type Line,
  MAX_READ,
  type Segment,
  endsTurn,
  hasEnded,
  hasWork,
  isInterruption,
  isMarked,
  markOf,
  readWindow,
  segments,
} from './transcript.js';

/**
 * The events the hook runs at: a turn's end, a turn ended by an API error —
 * which Claude Code reports instead of `Stop` — and the session's end.
 */
export type HookEvent = 'Stop' | 'StopFailure' | 'SessionEnd';

export interface HookInput {
  event: HookEvent;
  sessionId: string;
  transcriptPath: string;
}

export interface Deps {
  sender: (destination: Destination) => { send(record: RunRecord): Promise<boolean>; close(): Promise<void> };
  log: (line: string) => void;
  /** How long to wait for a turn's last lines that were not yet written; the tests shorten it. */
  lateLinesMs?: number;
  /** The most of a transcript read at once; the tests shrink it. */
  windowBytes?: number;
  /** How long a hook but the session's end waits for the lock; the tests shorten it. */
  lockWaitMs?: number;
}

/** How long a `Stop` or `StopFailure` waits for another hook of its session: the next hook sends what it leaves. */
const LOCK_WAIT_MS = 60_000;

/** Claude Code may write a turn's last lines after its `Stop` hook starts. */
const LATE_LINES_MS = 2_000;

/**
 * The most windows a turn longer than one is read in: past that, 256 MiB of
 * the transcript, it goes in parts, each a run.
 */
const MOST_WINDOWS = 16;

/** The runs remembered as sent: more than any session holds turns. */
const SENT_KEPT = 5_000;

/** A subagent's kind names a step: a plain name, or none. */
const AGENT_TYPE = /^[\w.:-]{1,64}$/;

/**
 * How long a subagent's transcript may go unwritten while it holds the turn
 * that started it: one tool of its own may run that long.
 */
const SUBAGENT_IDLE_MS = 30 * 60_000;

/**
 * The subagents' transcripts beside the session's, found by the tool call
 * that started each — its `.meta.json` names it — and read once, when first
 * asked for.
 */
export function subagentsOf(transcriptPath: string): (toolUseId: string) => Subagent | undefined {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
  let index: Map<string, { path: string; type: string | undefined }> | undefined;
  const read = new Map<string, Subagent>();
  return (toolUseId) => {
    if (index === undefined) {
      index = new Map();
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        // No subagent ran in this session.
      }
      for (const name of names) {
        if (!name.endsWith('.meta.json')) continue;
        try {
          const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { toolUseId?: unknown; agentType?: unknown };
          if (typeof meta.toolUseId !== 'string') continue;
          const type = typeof meta.agentType === 'string' && AGENT_TYPE.test(meta.agentType) ? meta.agentType : undefined;
          index.set(meta.toolUseId, { path: join(dir, name.replace(/\.meta\.json$/, '.jsonl')), type });
        } catch {
          // Half written, or not Claude Code's: that subagent's calls go unread.
        }
      }
    }
    const found = index.get(toolUseId);
    if (found === undefined) return undefined;
    let subagent = read.get(found.path);
    if (subagent === undefined) {
      let entries: Entry[] = [];
      let touched = 0;
      try {
        touched = statSync(found.path).mtimeMs;
        entries = readWindow(found.path, 0, MAX_READ * MOST_WINDOWS).lines.map((line) => line.entry);
      } catch {
        // Removed since: the step stands without its calls.
      }
      subagent = { type: found.type, ...firstRun(entries), touched };
      read.set(found.path, subagent);
    }
    return subagent;
  };
}

/**
 * A subagent's work up to the end of its first run, and whether it has
 * ended: a subagent resumed in a later turn writes on in the same transcript.
 */
function firstRun(entries: Entry[]): { entries: Entry[]; ended: boolean } {
  for (const [index, entry] of entries.entries()) {
    if (!endsTurn(entry) && !isInterruption(entry)) continue;
    // The reply's lines after the first that carries its stop reason are still the reply.
    let end = index + 1;
    const id = entry.message?.id;
    while (id !== undefined && entries[end]?.type === 'assistant' && entries[end]?.message?.id === id) end++;
    return { entries: entries.slice(0, end), ended: true };
  }
  return { entries, ended: false };
}

/**
 * Whether a subagent the segment started is still at work: in the
 * background, it writes on after the turn that started it has ended. One
 * that has written nothing for `SUBAGENT_IDLE_MS` is taken to have stopped.
 */
function waitsOnSubagent(segment: Segment, context: Context): boolean {
  return subagentsIn(segment, context).some((subagent) => !subagent.ended && Date.now() - subagent.touched < SUBAGENT_IDLE_MS);
}

/**
 * Each line once: a line Claude Code wrote again carries the id it had. The
 * line kept before a dropped one takes its end, so what is saved as read
 * still reaches past it.
 */
function once(lines: Line[]): Line[] {
  const seen = new Set<string>();
  const out: Line[] = [];
  for (const line of lines) {
    const id = line.entry.uuid;
    if (typeof id === 'string' && seen.has(id)) {
      const last = out.at(-1);
      if (last !== undefined) out[out.length - 1] = { ...last, end: line.end };
      continue;
    }
    if (typeof id === 'string') seen.add(id);
    out.push(line);
  }
  return out;
}

function timesOf(segment: Segment): number[] {
  return segment.entries.flatMap((entry) => {
    const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    return Number.isFinite(time) ? [time] : [];
  });
}

/**
 * Whether the transcript is still the one the saved place is a place in:
 * no smaller, and the line before the place the one that was there.
 */
function stillAt(path: string, state: SessionState): boolean {
  if (state.offset === 0) return true;
  if (statSync(path).size < state.offset) return false;
  const mark = markOf(path, state.offset);
  return state.mark === undefined ? mark !== undefined : mark === state.mark;
}

/**
 * The transcript from where the session's state left it, or from the top
 * where the file has shrunk or been rewritten under that place. A turn
 * longer than the window is read whole, the window doubled until it holds
 * the next turn's opening, up to `MOST_WINDOWS` windows.
 */
function readFrom(
  path: string,
  state: SessionState,
  max = MAX_READ,
): { offset: number; lines: Line[]; more: boolean; skipTo?: number } {
  const offset = stillAt(path, state) ? state.offset : 0;
  let window = readWindow(path, offset, max);
  let lines = once(window.lines);
  const alone = (): boolean => segments(lines, state.marked === true || isMarked(lines)).length === 1;
  for (let span = max; window.more && span < max * MOST_WINDOWS && alone(); ) {
    span = Math.min(span * 2, max * MOST_WINDOWS);
    window = readWindow(path, offset, span);
    lines = once(window.lines);
  }
  const read = { offset, lines, more: window.more };
  return window.skipTo === undefined ? read : { ...read, skipTo: window.skipTo };
}

/** A place to save: where to read on from, and what the line before it is known by. */
function placeAt(path: string, state: SessionState, offset: number): SessionState {
  const { mark: _, ...rest } = state;
  const mark = markOf(path, offset);
  return mark === undefined ? { ...rest, offset } : { ...rest, offset, mark };
}

/** Logs `line` once a session, remembered in its state as `flag`. */
function logOnce(dir: string, sessionId: string, flag: 'warnedNoKey' | 'warnedEndpoint', line: string, log: Deps['log']): void {
  const state = readState(dir, sessionId);
  if (state[flag] === true) return;
  log(line);
  writeState(dir, sessionId, { ...state, [flag]: true });
}

export async function sync(input: HookInput, settings: Settings, deps: Deps): Promise<void> {
  const { apiKey } = settings;
  if (apiKey === undefined) {
    const line = 'no key: set it with /plugin configure, or TELMONI_API_KEY; nothing is sent until then';
    logOnce(settings.dir, input.sessionId, 'warnedNoKey', line, deps.log);
    return;
  }
  // Nothing follows the session's end: its copy outwaits any live holder, whose sending no fixed wait bounds.
  const waitMs = input.event === 'SessionEnd' ? Number.POSITIVE_INFINITY : (deps.lockWaitMs ?? LOCK_WAIT_MS);
  const locked = await withLock(settings.dir, input.sessionId, waitMs, async () => {
    let sender: ReturnType<Deps['sender']>;
    try {
      sender = deps.sender({ endpoint: settings.endpoint, apiKey });
    } catch (error) {
      // The SDK's refusal names the endpoint's host at most, never a path, a key or anything of the session.
      if (!(error instanceof TypeError)) throw error;
      const line = `endpoint refused by the SDK (${error.message}): set another with /plugin configure, or TELMONI_ENDPOINT`;
      logOnce(settings.dir, input.sessionId, 'warnedEndpoint', `${line}; nothing is sent until then`, deps.log);
      return;
    }
    try {
      // The session's end is the last hook it gets, so it reads on to the transcript's end or a turn it cannot send yet.
      while ((await pass(input, settings, deps, sender)) && input.event === 'SessionEnd');
    } finally {
      await sender.close();
    }
  });
  if (!locked) deps.log('busy: another hook of this session held the lock past its wait; the next hook sends');
}

/**
 * One window of the transcript, its ended turns sent in order as far as they
 * can be, and the place after each saved; whether there is more to read past
 * where it saved.
 */
async function pass(input: HookInput, settings: Settings, deps: Deps, sender: ReturnType<Deps['sender']>): Promise<boolean> {
  const state = readState(settings.dir, input.sessionId);
  let read = readFrom(input.transcriptPath, state, deps.windowBytes);
  if (read.lines.length === 0) {
    if (read.skipTo === undefined) return false;
    writeState(settings.dir, input.sessionId, placeAt(input.transcriptPath, state, read.skipTo));
    return true;
  }
  let marked = state.marked === true || isMarked(read.lines);
  let all = segments(read.lines, marked);
  const stopping = input.event === 'Stop' || input.event === 'StopFailure';
  if (stopping && !read.more && !hasEnded(all.at(-1)!)) {
    await sleep(deps.lateLinesMs ?? LATE_LINES_MS);
    read = readFrom(input.transcriptPath, state, deps.windowBytes);
    marked = marked || isMarked(read.lines);
    all = segments(read.lines, marked);
  }
  const { offset, more } = read;
  // Where the file runs on past the window, the window's last segment may
  // be cut midway, and waits for the next hook — unless it is all the
  // window holds, a turn longer than the most a hook reads, sent in parts.
  // Otherwise the last segment is the turn still going, unless the turn
  // just stopped or the session is over; the ones before it have each been
  // followed by another turn's opening.
  const ending = input.event === 'SessionEnd' && !more;
  const last = (segment: Segment): boolean =>
    more ? all.length === 1 : ending || (stopping && hasEnded(segment));
  const closed = all.filter((segment, index) => index < all.length - 1 || last(segment));
  const sent = new Set(state.sent ?? []);
  let through = state.through;
  const save = (end: number): void => {
    const next = placeAt(input.transcriptPath, state, end);
    if (marked) next.marked = true;
    if (sent.size > 0) next.sent = [...sent].slice(-SENT_KEPT);
    if (through !== undefined) next.through = through;
    writeState(settings.dir, input.sessionId, next);
  };
  if (closed.length === 0) {
    if (offset !== state.offset || (marked && !state.marked)) save(offset);
    return false;
  }
  const context: Context = {
    sessionId: input.sessionId,
    provider: settings.provider,
    subagent: subagentsOf(input.transcriptPath),
    sessionEnded: false,
  };
  for (const segment of closed) {
    // A background subagent still at work holds its turn, and those after, for a later hook, so its step holds all its work.
    if (input.event !== 'SessionEnd' && waitsOnSubagent(segment, context)) return false;
    const record = hasWork(segment)
      ? recordOf(segment, { ...context, sessionEnded: ending && segment === all.at(-1) })
      : undefined;
    // Lines Claude Code wrote again, or read again after a shrink, are passed over: a run by its id, a continuation by its time.
    const times = timesOf(segment);
    const old =
      record !== undefined &&
      (sent.has(record.runId) ||
        (segment.opener === undefined && through !== undefined && (times[0] ?? 0) <= through));
    if (record !== undefined && !old) {
      if (!(await sender.send(record))) return false;
      sent.delete(record.runId);
      sent.add(record.runId);
    }
    if (record !== undefined) for (const time of times) through = Math.max(through ?? time, time);
    save(segment.end);
  }
  return more;
}
