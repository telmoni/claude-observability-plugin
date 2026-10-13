import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Entry, blocksOf, hasEnded, isInterruption, isMarked, opensTurn, readLines, segments } from '../src/transcript';
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

  it('keeps of each entry what the plugin reads, and nothing of what was said', () => {
    const path = join(dir.path, 'session.jsonl');
    const said = 'SAID-what-was-said';
    const at = '2026-10-12T09:00:00.000Z';
    const entries: unknown[] = [
      {
        type: 'user',
        uuid: 'p',
        timestamp: at,
        cwd: `/home/someone/${said}`,
        gitBranch: said,
        turnPosition: { promptIndex: 1, turnIndex: 1 },
        message: { role: 'user', content: `${said}: read /home/someone/notes.txt` },
      },
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: at,
        requestId: said,
        message: {
          id: 'm',
          model: 'claude-opus-5-5',
          stop_reason: 'tool_use',
          usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, iterations: [said] },
          content: [
            { type: 'thinking', thinking: said, signature: said },
            { type: 'text', text: said },
            { type: 'tool_use', id: 't', name: 'Bash', input: { command: said } },
            { type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'skill-a', args: said } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r',
        timestamp: at,
        toolUseResult: { stdout: said },
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: said, is_error: true }] },
      },
      { type: 'last-prompt', lastPrompt: said },
      { type: 'assistant', uuid: 'e', timestamp: at, isApiErrorMessage: true, error: said, message: { model: '<synthetic>', content: [{ type: 'text', text: said }] } },
      { type: 'user', uuid: 'i', timestamp: at, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    ];
    writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    const lines = readLines(path, 0);
    expect(JSON.stringify(lines)).not.toMatch(/SAID|someone|notes/);
    expect(lines.map((line) => line.entry.uuid)).toEqual(['p', 'a', 'r', undefined, 'e', 'i']);
    expect(opensTurn(lines[0]!.entry, true)).toBe(true);
    const reply = lines[1]!.entry;
    expect(reply.message).toMatchObject({
      id: 'm',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    });
    expect(blocksOf(reply).map((block) => [block.type, block.id, block.name, block.input])).toEqual([
      ['thinking', undefined, undefined, undefined],
      ['text', undefined, undefined, undefined],
      ['tool_use', 't', 'Bash', undefined],
      ['tool_use', 's', 'Skill', { skill: 'skill-a' }],
    ]);
    expect(blocksOf(lines[2]!.entry)).toEqual([{ type: 'tool_result', tool_use_id: 't', is_error: true }]);
    expect(lines[4]!.entry.isApiErrorMessage).toBe(true);
    expect(isInterruption(lines[5]!.entry)).toBe(true);
  });

  it('reads a window larger than what it holds in memory at once, a line across the seam read whole', () => {
    const path = join(dir.path, 'session.jsonl');
    const many = Array.from({ length: 6_000 }, (_, index) =>
      JSON.stringify({ type: 'attachment', uuid: `u${index}`, timestamp: '2026-10-12T09:00:00.000Z', padding: 'x'.repeat((index * 37) % 1_000) }),
    );
    writeFileSync(path, many.map((line) => `${line}\n`).join(''));
    expect(statSync(path).size).toBeGreaterThan(2 * 1024 * 1024);
    const lines = readLines(path, 0);
    expect(lines.map((line) => line.entry.uuid)).toEqual(many.map((_, index) => `u${index}`));
    let end = 0;
    lines.forEach((line, index) => {
      end += Buffer.byteLength(many[index]!) + 1;
      expect(line.end).toBe(end);
    });
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

  it('has not ended at a reply that paused for a tool the API runs itself, after which the turn goes on', () => {
    const paused: Entry = {
      type: 'assistant',
      uuid: 'r',
      timestamp: '2026-10-12T09:00:01.000Z',
      message: { id: 'm', model: 'claude', stop_reason: 'pause_turn', content: [] },
    };
    expect(hasEnded({ opener: prompt('a'), entries: [prompt('a'), paused], end: 0 })).toBe(false);
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
