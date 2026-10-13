import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Entry, hasEnded, isMarked, opensTurn, readLines, segments } from '../src/transcript';
import { fixture, tempDir } from './helpers';

let dir: { path: string; remove: () => void };

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.remove();
});

const prompt = (uuid: string, marked = true): Entry => ({
  type: 'user',
  uuid,
  timestamp: '2026-10-12T09:00:00.000Z',
  ...(marked ? { turnPosition: { promptIndex: 1, turnIndex: 1 } } : {}),
  message: { content: '…' },
});

describe('a transcript', () => {
  it('is read from an offset, line by whole line, a line still being written left for later', () => {
    const path = join(dir.path, 'session.jsonl');
    const first = `${JSON.stringify(prompt('a'))}\n`;
    writeFileSync(path, `${first}not json\n${JSON.stringify(prompt('b'))}\n{"type":"user","uuid":"c"`);
    const lines = readLines(path, 0);
    expect(lines.map((line) => line.entry.uuid)).toEqual(['a', 'b']);
    expect(lines[0]!.end).toBe(Buffer.byteLength(first));
    expect(readLines(path, lines[1]!.end)).toEqual([]);
    appendFileSync(path, '}\n');
    expect(readLines(path, lines[1]!.end).map((line) => line.entry.uuid)).toEqual(['c']);
  });

  it('opens a turn where Claude Code marks one, and never at a summary, a command or a tool result', () => {
    expect(opensTurn(prompt('a'), true)).toBe(true);
    expect(opensTurn({ ...prompt('a'), isCompactSummary: true }, true)).toBe(false);
    expect(opensTurn({ ...prompt('a'), isMeta: true }, true)).toBe(false);
    expect(opensTurn(prompt('a', false), true)).toBe(false);
  });

  it('reads an unmarked transcript by its prompts: text or an image, never a tag, an interruption or a result', () => {
    const text = (content: unknown): Entry => ({ type: 'user', uuid: 'u', message: { content } });
    expect(opensTurn(text('why does this fail?'), false)).toBe(true);
    expect(opensTurn(text([{ type: 'image' }]), false)).toBe(true);
    expect(opensTurn(text('<command-name>/model</command-name>'), false)).toBe(false);
    expect(opensTurn(text([{ type: 'text', text: '[Request interrupted by user]' }]), false)).toBe(false);
    expect(opensTurn(text([{ type: 'tool_result', tool_use_id: 't' }]), false)).toBe(false);
  });

  it('is cut into the turns of a recorded session, each ended', () => {
    const lines = readLines(fixture('subagent'), 0);
    expect(isMarked(lines)).toBe(true);
    const turns = segments(lines, true);
    expect(turns).toHaveLength(3);
    expect(turns.every((turn) => turn.opener !== undefined && hasEnded(turn))).toBe(true);
    expect(turns.at(-1)!.end).toBe(lines.at(-1)!.end);
  });

  it('begins with a continuation where the read begins inside a turn', () => {
    const lines = readLines(fixture('subagent'), 0);
    const second = segments(lines, true)[1]!;
    const inside = lines.findIndex((line) => line.entry === second.entries[3]);
    const read = readLines(fixture('subagent'), lines[inside - 1]!.end);
    const [continuation, ...rest] = segments(read, true);
    expect(continuation!.opener).toBeUndefined();
    expect(rest).toHaveLength(1);
  });

  it('has not ended while a tool is still to answer', () => {
    const asking: Entry = {
      type: 'assistant',
      uuid: 'r',
      timestamp: '2026-10-12T09:00:01.000Z',
      message: { id: 'm', model: 'claude', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash' }] },
    };
    const turn = { opener: prompt('a'), entries: [prompt('a'), asking], end: 0 };
    expect(hasEnded(turn)).toBe(false);
    const interrupted: Entry = { type: 'user', uuid: 'i', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
    expect(hasEnded({ ...turn, entries: [...turn.entries, interrupted] })).toBe(true);
  });
});
