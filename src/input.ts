/** What a hook is handed: by Claude Code on stdin, or by the hook to its detached copy. */

import { isAbsolute } from 'node:path';

import type { HookEvent, HookInput } from './session.js';
import { isSessionId } from './state.js';

const EVENTS = new Set<HookEvent>(['Stop', 'StopFailure', 'SessionEnd']);

/**
 * Cursor runs Claude Code's hooks too, a plugin's among them, handing them
 * its own events: Telmoni's Cursor plugin records those sessions, so this
 * one leaves them alone.
 */
export function isCursor(raw: unknown, env: NodeJS.ProcessEnv): boolean {
  const fields = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return typeof fields['cursor_version'] === 'string' || Boolean(env['CURSOR_VERSION']);
}

/** The event, the session and its transcript; nothing else Claude Code sends is read. */
export function inputFrom(raw: unknown): HookInput | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const fields = raw as Record<string, unknown>;
  const event = fields['hook_event_name'] ?? fields['event'];
  const sessionId = fields['session_id'] ?? fields['sessionId'];
  const transcriptPath = fields['transcript_path'] ?? fields['transcriptPath'];
  if (typeof event !== 'string' || !EVENTS.has(event as HookEvent)) return undefined;
  if (!isSessionId(sessionId)) return undefined;
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) {
    return undefined;
  }
  return { event: event as HookEvent, sessionId, transcriptPath };
}
