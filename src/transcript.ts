/**
 * A Claude Code transcript, read as far as the turns' metadata goes.
 *
 * A transcript is JSON Lines, one entry per line, appended as the session
 * goes. A turn opens at the entry that carries `turnPosition` — a prompt, a
 * scheduled prompt or a background task's notice — and runs to the next one.
 * Of each entry the plugin reads its kind, id, time and flags; of a reply its
 * id, model, stop reason and token counts; of a tool call its id and name, and
 * of the Skill tool the skill's name alone; of a tool's result whether it was
 * an error. A prompt's text is looked at only to tell an interruption from a
 * prompt, and nothing of it is kept.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  text?: unknown;
}

export interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  error?: unknown;
  turnPosition?: unknown;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: Usage;
    content?: unknown;
  };
}

/** An entry, and where in the file the line after it begins. */
export interface Line {
  entry: Entry;
  end: number;
}

/**
 * The most of a transcript read at once: a long session's transcript runs to
 * hundreds of megabytes, and a plugin installed midway catches up a window a
 * hook.
 */
export const MAX_READ = 16 * 1024 * 1024;

/** The whole lines read, and whether the file holds more past them. */
export interface Window {
  lines: Line[];
  more: boolean;
  /** Where to read on from, past a line too long to read, when the window held nothing else. */
  skipTo?: number | undefined;
}

/** The whole lines from `offset` on; see `readWindow`. */
export function readLines(path: string, offset: number): Line[] {
  return readWindow(path, offset).lines;
}

/**
 * The whole lines from `offset` on, at most `max` bytes of them. A last line
 * with no newline yet is still being written and is left for the next read;
 * a line that is not JSON is passed over.
 */
export function readWindow(path: string, offset: number, max = MAX_READ): Window {
  const size = statSync(path).size;
  if (offset >= size) return { lines: [], more: false };
  const length = Math.min(size - offset, max);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline === -1) break;
    const text = buffer.subarray(start, newline).toString('utf8').trim();
    start = newline + 1;
    if (text === '') continue;
    try {
      const entry = JSON.parse(text) as unknown;
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        lines.push({ entry: entry as Entry, end: offset + start });
      }
    } catch {
      // A line torn by a crash, or not Claude Code's: nothing in it is read.
    }
  }
  const more = offset + length < size;
  if (start === 0 && more) {
    // One line longer than a window — a pasted image, say — is passed over
    // as an unreadable one is, rather than read for ever.
    return { lines, more, skipTo: endOfLine(path, offset + length, size, max) };
  }
  return { lines, more };
}

/** Where the line running on at `from` ends, past its newline; the file's end if it has none yet. */
function endOfLine(path: string, from: number, size: number, max: number): number | undefined {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(max, 1024 * 1024));
    for (let at = from; at < size; ) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at);
      if (n === 0) break;
      const newline = chunk.subarray(0, n).indexOf(0x0a);
      if (newline !== -1) return at + newline + 1;
      at += n;
    }
  } finally {
    closeSync(fd);
  }
  // Still being written: the next hook looks again.
  return undefined;
}

export function blocksOf(entry: Entry): Block[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? content.filter((b): b is Block => b !== null && typeof b === 'object') : [];
}

/** The start of what a person typed or pasted: enough to tell its kind, never kept. */
function leadingText(entry: Entry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trimStart().slice(0, 32);
  for (const block of blocksOf(entry)) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text.trimStart().slice(0, 32);
  }
  return '';
}

export function isToolResult(entry: Entry): boolean {
  return entry.type === 'user' && blocksOf(entry).some((b) => b.type === 'tool_result');
}

export function isInterruption(entry: Entry): boolean {
  return entry.type === 'user' && leadingText(entry).startsWith('[Request interrupted');
}

/**
 * Whether `entry` opens a turn. Claude Code marks each with `turnPosition`;
 * a transcript written before it did is read by its prompts: a person's own
 * text or image, never a command's output, a notice, an interruption or a
 * summary.
 */
export function opensTurn(entry: Entry, marked: boolean): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return false;
  if (marked) return entry.turnPosition !== undefined && entry.turnPosition !== null;
  if (isToolResult(entry) || isInterruption(entry)) return false;
  const lead = leadingText(entry);
  if (lead.startsWith('<')) return false;
  return lead !== '' || blocksOf(entry).some((b) => b.type === 'image');
}

/** The work between one opening and the next: a turn, or a turn's continuation. */
export interface Segment {
  /** The entry that opened the turn; absent where the read began inside one. */
  opener: Entry | undefined;
  entries: Entry[];
  /** Where the line after the segment's last begins. */
  end: number;
}

/** `lines` cut into segments at each turn's opening. */
export function segments(lines: readonly Line[], marked: boolean): Segment[] {
  const out: Segment[] = [];
  let current: Segment | undefined;
  for (const { entry, end } of lines) {
    if (opensTurn(entry, marked)) {
      current = { opener: entry, entries: [entry], end };
      out.push(current);
    } else {
      if (current === undefined) {
        current = { opener: undefined, entries: [], end };
        out.push(current);
      }
      current.entries.push(entry);
      current.end = end;
    }
  }
  return out;
}

/** Whether any line carries Claude Code's turn marker, as every version since it began does. */
export function isMarked(lines: readonly Line[]): boolean {
  return lines.some(({ entry }) => entry.type === 'user' && entry.turnPosition !== undefined);
}

/** A model's reply that ends a turn rather than asking for a tool. */
export function endsTurn(entry: Entry): boolean {
  if (entry.type !== 'assistant') return false;
  if (entry.isApiErrorMessage) return true;
  const reason = entry.message?.stop_reason;
  return typeof reason === 'string' && reason !== 'tool_use';
}

/**
 * Whether the segment's work has ended as far as the transcript shows: its
 * last reply ended the turn, or the person interrupted it after that reply.
 */
export function hasEnded(segment: Segment): boolean {
  for (let i = segment.entries.length - 1; i >= 0; i--) {
    const entry = segment.entries[i]!;
    if (entry.isSidechain) continue;
    if (isInterruption(entry)) return true;
    if (entry.type === 'assistant') return endsTurn(entry);
    if (isToolResult(entry)) return false;
  }
  return false;
}

/** Whether the segment holds any of the model's work, which is what makes it a run. */
export function hasWork(segment: Segment): boolean {
  return segment.entries.some((entry) => entry.type === 'assistant' && !entry.isSidechain);
}
