/**
 * One hook's work on one session: the turns that have ended since the last
 * hook sent, each sent as a run, and the place they end saved after each, so
 * a turn is sent once and none is skipped.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { RunRecord } from 'telmoni';

import { type Context, type Subagent, recordOf } from './record.js';
import type { Destination } from './send.js';
import type { Settings } from './settings.js';
import { type SessionState, readState, withLock, writeState } from './state.js';
import {
  type Line,
  type Segment,
  hasEnded,
  hasWork,
  isMarked,
  readLines,
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
}

/** How long a hook waits for another of the same session to finish. */
const LOCK_WAIT_MS = 60_000;

/** Claude Code may write a turn's last lines after its `Stop` hook starts. */
const LATE_LINES_MS = 2_000;

/** The runs remembered as sent: more than any session holds turns. */
const SENT_KEPT = 5_000;

/** A subagent's kind names a step: a plain name, or none. */
const AGENT_TYPE = /^[\w.:-]{1,64}$/;

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
      let entries: Subagent['entries'] = [];
      try {
        entries = readLines(found.path, 0).map((line) => line.entry);
      } catch {
        // Removed since: the step stands without its calls.
      }
      subagent = { type: found.type, entries };
      read.set(found.path, subagent);
    }
    return subagent;
  };
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

/** The transcript from where the session's state left it; from the top again if the file has shrunk below that. */
function readFrom(
  path: string,
  state: SessionState,
  max: number | undefined,
): { offset: number; lines: Line[]; more: boolean; skipTo?: number } {
  const offset = statSync(path).size < state.offset ? 0 : state.offset;
  const window = readWindow(path, offset, max);
  const read = { offset, lines: once(window.lines), more: window.more };
  return window.skipTo === undefined ? read : { ...read, skipTo: window.skipTo };
}

export async function sync(input: HookInput, settings: Settings, deps: Deps): Promise<void> {
  const { apiKey } = settings;
  if (apiKey === undefined) {
    const state = readState(settings.dir, input.sessionId);
    if (!state.warnedNoKey) {
      deps.log('no key: set it with /plugin configure, or TELMONI_API_KEY; nothing is sent until then');
      writeState(settings.dir, input.sessionId, { ...state, warnedNoKey: true });
    }
    return;
  }
  const locked = await withLock(settings.dir, input.sessionId, LOCK_WAIT_MS, async () => {
    const state = readState(settings.dir, input.sessionId);
    let read = readFrom(input.transcriptPath, state, deps.windowBytes);
    if (read.lines.length === 0) {
      if (read.skipTo !== undefined) writeState(settings.dir, input.sessionId, { ...state, offset: read.skipTo });
      return;
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
    // window holds, a turn longer than a window, sent a window at a time.
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
      const next: SessionState = { ...state, offset: end };
      if (marked) next.marked = true;
      if (sent.size > 0) next.sent = [...sent].slice(-SENT_KEPT);
      if (through !== undefined) next.through = through;
      writeState(settings.dir, input.sessionId, next);
    };
    if (closed.length === 0) {
      if (offset !== state.offset || (marked && !state.marked)) save(offset);
      return;
    }
    const context: Context = {
      sessionId: input.sessionId,
      provider: settings.provider,
      subagent: subagentsOf(input.transcriptPath),
      sessionEnded: false,
    };
    const sender = deps.sender({ endpoint: settings.endpoint, apiKey });
    try {
      for (const segment of closed) {
        const record = hasWork(segment)
          ? recordOf(segment, { ...context, sessionEnded: ending && segment === all.at(-1) })
          : undefined;
        // A turn read before, written again by Claude Code or read again
        // after the file shrank, is passed over: a run already sent by its
        // id, and work that opens no turn by being no later than the last
        // line of the session's own that was sent — never a background
        // subagent's, whose work may run on past a continuation's start.
        const times = timesOf(segment);
        const old =
          record !== undefined &&
          (sent.has(record.runId) ||
            (segment.opener === undefined && through !== undefined && (times[0] ?? 0) <= through));
        if (record !== undefined && !old) {
          if (!(await sender.send(record))) return;
          sent.delete(record.runId);
          sent.add(record.runId);
        }
        if (record !== undefined) for (const time of times) through = Math.max(through ?? time, time);
        save(segment.end);
      }
    } finally {
      await sender.close();
    }
  });
  if (!locked) deps.log('busy: another hook of this session held the lock past its wait; the next hook sends');
}
