/**
 * What has been sent of each session, `<session_id>.json` in the plugin's
 * folder, and the lock that keeps two hooks of one session from sending the
 * same turns at once.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface SessionState {
  /** Where in the transcript the first turn not yet sent begins, in bytes. */
  offset: number;
  /**
   * What the line before `offset` was known by when it was saved (`markOf`):
   * a transcript rewritten under the place reads otherwise there, and is read
   * from the top.
   */
  mark?: string;
  /**
   * The runs sent, newest last, and when the last of them ended: Claude Code
   * can write a session's old lines into its transcript again, and shrink it,
   * and a turn read a second time is known by these rather than sent twice.
   */
  sent?: string[];
  through?: number;
  /**
   * Whether the transcript marks its turns' openings, as every Claude Code
   * since it began does: a read that begins inside a turn may hold no mark.
   */
  marked?: boolean;
  /** Whether a missing key has been logged for this session, so it is logged once. */
  warnedNoKey?: boolean;
  /** Whether an endpoint the SDK refused has been logged for this session, so it is logged once. */
  warnedEndpoint?: boolean;
}

/** A session id names a file here: anything but a plain id is refused. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The session's state: afresh only where none was saved, since one read as new would send the session again from the top. */
export function readState(dir: string, sessionId: string): SessionState {
  let text: string;
  try {
    text = readFileSync(join(dir, `${sessionId}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { offset: 0 };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('session state is not an object');
  const parsed = value as Partial<SessionState>;
  const state: SessionState = {
    offset: typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0,
  };
  if (typeof parsed.mark === 'string') state.mark = parsed.mark;
  if (parsed.marked === true) state.marked = true;
  if (parsed.warnedNoKey === true) state.warnedNoKey = true;
  if (parsed.warnedEndpoint === true) state.warnedEndpoint = true;
  if (Array.isArray(parsed.sent)) state.sent = parsed.sent.filter((id): id is string => typeof id === 'string');
  if (typeof parsed.through === 'number' && Number.isFinite(parsed.through)) state.through = parsed.through;
  return state;
}

export function writeState(dir: string, sessionId: string, state: SessionState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.json`);
  // Synced aside, then renamed over: a hook killed, or a machine stopped, mid-write leaves the last state whole.
  const fd = openSync(`${path}.tmp`, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${path}.tmp`, path);
}

/** A lock untouched for this long was left by a hook that died holding it. */
const STALE_MS = 120_000;

/**
 * Holds the session's lock while `work` runs, waiting up to `waitMs` for a
 * hook already holding it; false, and `work` not run, if it never comes free.
 * `staleMs` is the tests' way to shorten how long an untouched lock stands.
 */
export async function withLock(
  dir: string,
  sessionId: string,
  waitMs: number,
  work: () => Promise<void>,
  staleMs = STALE_MS,
): Promise<boolean> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.lock`);
  // Written into the lock, so a hook lets go of its own lock and never of one
  // another hook took from it, found stale after a sleep of the machine.
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
      } catch {
        // Freed between the two calls.
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }
  // Touched while held: a hook still sending to a slow Telmoni is never taken
  // for one that died, however long its sending takes.
  const touch = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // Taken away: the release below leaves it alone.
    }
  }, staleMs / 4);
  touch.unref();
  try {
    await work();
  } finally {
    clearInterval(touch);
    try {
      if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
    } catch {
      // Gone already.
    }
  }
  return true;
}
