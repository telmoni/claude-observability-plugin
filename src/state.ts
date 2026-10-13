/**
 * What has been sent of each session, `<session_id>.json` in the plugin's
 * folder, and the lock that keeps two hooks of one session from sending the
 * same turns at once.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface SessionState {
  /** Where in the transcript the first turn not yet sent begins, in bytes. */
  offset: number;
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
}

/** A session id names a file here: anything but a plain id is refused. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function readState(dir: string, sessionId: string): SessionState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8')) as Partial<SessionState>;
    const state: SessionState = {
      offset: typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0,
    };
    if (parsed.marked === true) state.marked = true;
    if (parsed.warnedNoKey === true) state.warnedNoKey = true;
    if (Array.isArray(parsed.sent)) state.sent = parsed.sent.filter((id): id is string => typeof id === 'string');
    if (typeof parsed.through === 'number' && Number.isFinite(parsed.through)) state.through = parsed.through;
    return state;
  } catch {
    return { offset: 0 };
  }
}

export function writeState(dir: string, sessionId: string, state: SessionState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.json`);
  // Written aside and renamed over, so a hook killed mid-write leaves the
  // last state whole rather than half of the new one.
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** A lock older than this was left by a hook that died holding it. */
const STALE_MS = 120_000;

/**
 * Holds the session's lock while `work` runs, waiting up to `waitMs` for a
 * hook already holding it; false, and `work` not run, if it never comes free.
 */
export async function withLock(
  dir: string,
  sessionId: string,
  waitMs: number,
  work: () => Promise<void>,
): Promise<boolean> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { force: true });
      } catch {
        // Freed between the two calls.
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }
  try {
    await work();
  } finally {
    rmSync(path, { force: true });
  }
  return true;
}
