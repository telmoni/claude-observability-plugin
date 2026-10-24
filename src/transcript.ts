/**
 * A Claude Code transcript — JSON Lines, a turn opening at each entry with `turnPosition` — read as far as the turns'
 * metadata goes: each line is cut down to its kinds, ids, times, counts and flags as it is parsed, before it is held.
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
  /** Claude Code's own hidden word to go on, after a reply cut off or answered with nothing: the run goes on. */
  turnCompanion?: boolean;
  /** Claude Code's own kind for the error, a word like `rate_limit`: nothing else is kept. */
  error?: string;
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

/** The most of a transcript read at once: a long session's runs to hundreds of megabytes, caught up a window a hook. */
export const MAX_READ = 16 * 1024 * 1024;

/** How much of a window is held as bytes at once, the rest read as it is parsed. */
const CHUNK = 1024 * 1024;

/** The marker an interrupted turn's last line opens with. */
const INTERRUPTED = '[Request interrupted';

/** Claude Code's own name for an error's kind, such as `rate_limit`. */
const ERROR_KIND = /^[a-z][a-z_]{0,63}$/;

/** The whole lines read, and whether the file holds more past them. */
export interface Window {
  lines: Line[];
  more: boolean;
  /** Where to read on from, when the window held no line to read: past one too long for it, or past lines none could read. */
  skipTo?: number | undefined;
}

/** The whole lines from `offset` on; see `readWindow`. */
export function readLines(path: string, offset: number): Line[] {
  return readWindow(path, offset).lines;
}

/**
 * The whole lines from `offset` on, at most `max` bytes of them, each cut down to what the plugin reads. A last line
 * with no newline yet is still being written and is left for the next read; a line that is not JSON is passed over.
 */
export function readWindow(path: string, offset: number, max = MAX_READ): Window {
  const size = statSync(path).size;
  if (offset >= size) return { lines: [], more: false };
  const limit = Math.min(size, offset + max);
  const lines: Line[] = [];
  // Where the line being read began; still `offset` if none ended.
  let begun = offset;
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(CHUNK, limit - offset));
    let pending: Buffer[] = [];
    for (let at = offset; at < limit; ) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, limit - at), at);
      if (n === 0) break;
      const read = chunk.subarray(0, n);
      let from = 0;
      for (let newline = read.indexOf(0x0a); newline !== -1; newline = read.indexOf(0x0a, from)) {
        const tail = read.subarray(from, newline);
        const bytes = pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
        pending = [];
        begun = at + newline + 1;
        from = newline + 1;
        const entry = parsed(bytes);
        if (entry !== undefined) lines.push({ entry, end: begun });
      }
      // Copied: the chunk is read into again.
      if (from < n) pending.push(Buffer.from(read.subarray(from)));
      at += n;
    }
  } finally {
    closeSync(fd);
  }
  const more = limit < size;
  if (begun === offset && more) {
    // One line longer than a window — a pasted image, say — is passed over as an unreadable one is, rather than read for ever.
    return { lines, more, skipTo: endOfLine(path, limit, size, max) };
  }
  // Lines ended, none of them readable: past them, or a line too long for the window after them would hold the session there.
  if (lines.length === 0 && begun > offset) return { lines, more, skipTo: begun };
  return { lines, more };
}

function parsed(bytes: Buffer): Entry | undefined {
  const text = bytes.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) && !isPlaceholder(value) ? slim(value) : undefined;
  } catch {
    // A line torn by a crash, or not Claude Code's: nothing in it is read.
    return undefined;
  }
}

/** The reply Claude Code writes as it resumes a session whose last line was no reply, `No response requested.`: no model's, and no error. */
function isPlaceholder(raw: Record<string, unknown>): boolean {
  const message = raw['message'];
  return raw['type'] === 'assistant' && isObject(message) && message['model'] === '<synthetic>' && raw['isApiErrorMessage'] !== true && raw['error'] === undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Of an entry, what the plugin reads and nothing else: a prompt, a reply, a thought, a tool's input or output, a path
 * are gone before the entry is held, so nothing said in a session stays in memory longer than its line takes to parse.
 */
function slim(raw: Record<string, unknown>): Entry {
  const entry: Entry = {};
  if (typeof raw['type'] === 'string') entry.type = raw['type'];
  if (typeof raw['uuid'] === 'string') entry.uuid = raw['uuid'];
  if (typeof raw['timestamp'] === 'string') entry.timestamp = raw['timestamp'];
  if (raw['isMeta'] === true) entry.isMeta = true;
  if (raw['isCompactSummary'] === true) entry.isCompactSummary = true;
  if (raw['isSidechain'] === true) entry.isSidechain = true;
  if (raw['isApiErrorMessage'] === true) entry.isApiErrorMessage = true;
  if (raw['turnCompanion'] === true) entry.turnCompanion = true;
  if (typeof raw['error'] === 'string' && ERROR_KIND.test(raw['error'])) entry.error = raw['error'];
  if (raw['turnPosition'] !== undefined && raw['turnPosition'] !== null) entry.turnPosition = true;
  const message = raw['message'];
  if (!isObject(message)) return entry;
  const kept: NonNullable<Entry['message']> = {};
  if (typeof message['id'] === 'string') kept.id = message['id'];
  if (typeof message['model'] === 'string') kept.model = message['model'];
  const reason = message['stop_reason'];
  if (typeof reason === 'string' || reason === null) kept.stop_reason = reason;
  const usage = message['usage'];
  if (isObject(usage)) {
    const counts: Usage = {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
      const count = usage[key];
      if (typeof count === 'number') counts[key] = count;
    }
    kept.usage = counts;
  }
  const content = message['content'];
  if (typeof content === 'string') kept.content = kindOfText(content);
  else if (Array.isArray(content)) kept.content = content.filter(isObject).map(slimBlock);
  entry.message = kept;
  return entry;
}

function slimBlock(raw: Record<string, unknown>): Block {
  const block: Block = {};
  if (typeof raw['type'] === 'string') block.type = raw['type'];
  if (typeof raw['id'] === 'string') block.id = raw['id'];
  if (typeof raw['name'] === 'string') block.name = raw['name'];
  if (typeof raw['tool_use_id'] === 'string') block.tool_use_id = raw['tool_use_id'];
  if (raw['is_error'] === true) block.is_error = true;
  if (block.type === 'text' && typeof raw['text'] === 'string') block.text = kindOfText(raw['text']);
  // Of a tool's input, the one thing read: the name of the skill the Skill tool ran.
  const input = raw['input'];
  if (block.type === 'tool_use' && block.name === 'Skill' && isObject(input) && typeof input['skill'] === 'string') {
    block.input = { skill: input['skill'] };
  }
  return block;
}

/**
 * A text's kind in place of the text: an interruption's marker, a line
 * Claude Code wraps in a tag of its own, something a person wrote, or nothing.
 */
function kindOfText(text: string): string {
  const lead = text.trimStart();
  if (lead.startsWith(INTERRUPTED)) return INTERRUPTED;
  if (lead.startsWith('<')) return '<';
  return lead === '' ? '' : '…';
}

/** How far back from a place the line ending there is looked for. */
const MARK_MOST = 1024 * 1024;

/** An id, or a kind, as Claude Code spells them: nothing else is kept of a line. */
const PLAIN = /^[\w-]{1,64}$/;

/**
 * What the line ending at `end` is known by — its id, its kind, or only that a line ends there — and undefined where
 * none does. Saved beside the place, it tells a transcript rewritten under that place from one appended to.
 */
export function markOf(path: string, end: number): string | undefined {
  if (end <= 0) return undefined;
  const fd = openSync(path, 'r');
  try {
    let span = Math.min(end, 64 * 1024);
    for (;;) {
      const buffer = Buffer.alloc(span);
      if (readSync(fd, buffer, 0, span, end - span) < span || buffer[span - 1] !== 0x0a) return undefined;
      const newline = span > 1 ? buffer.lastIndexOf(0x0a, span - 2) : -1;
      if (newline !== -1 || span === end) return markOfLine(buffer.subarray(newline + 1, span - 1));
      if (span >= MARK_MOST) return '';
      span = Math.min(end, MARK_MOST);
    }
  } finally {
    closeSync(fd);
  }
}

function markOfLine(bytes: Buffer): string {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (isObject(value)) {
      if (typeof value['uuid'] === 'string' && PLAIN.test(value['uuid'])) return value['uuid'];
      if (typeof value['type'] === 'string' && PLAIN.test(value['type'])) return `kind:${value['type']}`;
    }
  } catch {
    // Not Claude Code's: known only as a line.
  }
  return '';
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
  return entry.type === 'user' && leadingText(entry).startsWith(INTERRUPTED);
}

/**
 * Whether `entry` opens a turn. Claude Code marks each with `turnPosition`; a transcript from before it did is read by
 * its prompts: a person's own text or image, never a command's output, a notice, an interruption or a summary.
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

/**
 * A model's reply that ends a turn rather than asking for a tool, or pausing
 * for one the API runs itself (`pause_turn`), after which the turn goes on.
 */
export function endsTurn(entry: Entry): boolean {
  if (entry.type !== 'assistant') return false;
  if (entry.isApiErrorMessage) return true;
  const reason = entry.message?.stop_reason;
  return typeof reason === 'string' && reason !== 'tool_use' && reason !== 'pause_turn';
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
