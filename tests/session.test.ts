import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type HookEvent, sync } from '../src/session';
import type { Settings } from '../src/settings';
import { readState, withLock } from '../src/state';
import { fixture, tempDir } from './helpers';

let dir: { path: string; remove: () => void };
let settings: Settings;
let sent: RunRecord[];
let lines: string[];
let answers: boolean[];
let logged: string[];

const SESSION = 'session-1';

beforeEach(() => {
  dir = tempDir();
  settings = { apiKey: 'telmoni_test', endpoint: undefined, dir: join(dir.path, 'telmoni'), provider: 'anthropic' };
  sent = [];
  answers = [];
  logged = [];
  lines = readFileSync(fixture('subagent'), 'utf8').split('\n').filter((line) => line.trim() !== '');
  const sessionDir = join(dir.path, SESSION, 'subagents');
  mkdirSync(sessionDir, { recursive: true });
  const fixtures = `${fixture('subagent').replace(/\.jsonl$/, '')}/subagents`;
  for (const name of ['agent-01.jsonl', 'agent-01.meta.json']) copyFileSync(join(fixtures, name), join(sessionDir, name));
});

afterEach(() => {
  dir.remove();
});

/** The transcript as Claude Code would have written it by the end of the `count`th line. */
function writtenThrough(count: number): string {
  const path = join(dir.path, `${SESSION}.jsonl`);
  writeFileSync(path, lines.slice(0, count).map((line) => `${line}\n`).join(''));
  return path;
}

function hook(event: HookEvent, path: string, overrides: Partial<Settings> = {}, lateLinesMs = 20): Promise<void> {
  return sync({ event, sessionId: SESSION, transcriptPath: path }, { ...settings, ...overrides }, {
    sender: () => ({
      send: (record) => {
        const ok = answers.shift() ?? true;
        if (ok) sent.push(record);
        return Promise.resolve(ok);
      },
      close: () => Promise.resolve(),
    }),
    log: (line) => void logged.push(line),
    lateLinesMs,
  });
}

const append = (path: string, more: string[]): void =>
  writeFileSync(path, more.map((line) => `${line}\n`).join(''), { flag: 'a' });

interface Line {
  type?: string;
  turnPosition?: unknown;
  message?: { stop_reason?: string };
}

const parsed = (index: number): Line => JSON.parse(lines[index]!) as Line;

/** Where each turn of the fixture opens, by line. */
function openings(): number[] {
  return lines.flatMap((_line, index) => (parsed(index).turnPosition !== undefined ? [index] : []));
}

/** The last line in [from, to) where the model asked for a tool: inside a turn, still going. */
function lastAsking(from: number, to: number): number {
  for (let index = to - 1; index >= from; index--) {
    const line = parsed(index);
    if (line.type === 'assistant' && line.message?.stop_reason === 'tool_use') return index;
  }
  throw new Error('no tool asked for');
}

describe('a hook', () => {
  it('sends each turn once it has ended, and saves where it stopped', async () => {
    const [, second] = openings();
    const path = writtenThrough(second!);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    writtenThrough(lines.length);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(3);
  });

  it('leaves a turn whose last line asks for a tool to a later hook', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(lastAsking(second!, third!) + 1);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    expect(readState(settings.dir, SESSION).offset).toBeLessThan(readFileSync(path).length);
  });

  it('waits for a turn’s last lines written after its stop', async () => {
    const [, second, third] = openings();
    const asking = lastAsking(second!, third!);
    const path = writtenThrough(asking + 1);
    setTimeout(() => append(path, lines.slice(asking + 1, third)), 100);
    await hook('Stop', path, {}, 600);
    expect(sent).toHaveLength(2);
  });

  it('sends a turn an API error ended at its StopFailure, failed with the error’s kind', async () => {
    const [, second] = openings();
    const path = writtenThrough(second! + 1);
    const opener = JSON.parse(lines[second!]!) as { timestamp: string };
    append(path, [
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-999999999998',
        timestamp: new Date(Date.parse(opener.timestamp) + 2000).toISOString(),
        isApiErrorMessage: true,
        error: 'overloaded',
        message: { model: '<synthetic>', content: [] },
      }),
    ]);
    await hook('StopFailure', path);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.errorType).toBe('overloaded');
  });

  it('sends nothing again when Claude Code writes old lines into the transcript a second time', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    const [, second] = openings();
    append(path, lines.slice(0, second));
    append(path, lines.slice(5, second));
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('reads a transcript that shrank from the top, and sends nothing it sent before', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    const [, second] = openings();
    writtenThrough(second!);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('closes the turn still running when the session ends, as cancelled', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(lastAsking(second!, third!) + 1);
    await hook('SessionEnd', path);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.cancelled).toBe(true);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('stops at a turn the platform did not take, and sends it again at the next hook', async () => {
    const path = writtenThrough(lines.length);
    answers = [true, false];
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    const [, second] = openings();
    const firstTurnEnd = Buffer.byteLength(lines.slice(0, second).map((line) => `${line}\n`).join(''));
    expect(readState(settings.dir, SESSION).offset).toBe(firstTurnEnd);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(3);
  });

  it('sends a turn that went on after its stop — another hook kept it going — as a run of its own', async () => {
    const [, second] = openings();
    const path = writtenThrough(second!);
    await hook('Stop', path);
    const reply = lines.slice(0, second).findLast((line) => (JSON.parse(line) as Line).type === 'assistant')!;
    const more = JSON.parse(reply) as { uuid: string; timestamp: string; message: { id: string } };
    more.uuid = '00000000-0000-4000-8000-999999999999';
    more.message.id = 'msg_continued';
    more.timestamp = new Date(Date.parse(more.timestamp) + 5000).toISOString();
    writeFileSync(path, `${JSON.stringify(more)}\n`, { flag: 'a' });
    await hook('Stop', path);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.runId).not.toBe(sent[0]!.runId);
    expect(sent[1]!.inside).toHaveLength(1);
  });

  it('catches up a long transcript a window a hook, each turn once', async () => {
    const path = writtenThrough(lines.length);
    const turns = openings();
    const sizes = turns.map((at, index) =>
      Buffer.byteLength(lines.slice(at, turns[index + 1] ?? lines.length).map((line) => `${line}\n`).join('')),
    );
    const windowBytes = Math.max(...sizes) + 64;
    expect(windowBytes).toBeLessThan(readFileSync(path).length);
    const catchUp = async (): Promise<void> => {
      for (let previous = -1; ; ) {
        await sync({ event: 'Stop', sessionId: SESSION, transcriptPath: path }, settings, {
          sender: () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() }),
          log: (line) => void logged.push(line),
          lateLinesMs: 0,
          windowBytes,
        });
        const { offset } = readState(settings.dir, SESSION);
        if (offset === previous) return;
        previous = offset;
      }
    };
    await catchUp();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('passes over a line longer than a window, as it does a line it cannot read', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(second!);
    const huge = JSON.stringify({ type: 'attachment', uuid: 'huge', timestamp: '2026-10-12T09:00:00.000Z', padding: 'x'.repeat(200_000) });
    append(path, [huge, ...lines.slice(second, third)]);
    for (let hook = 0; hook < 6; hook++) {
      await sync({ event: 'Stop', sessionId: SESSION, transcriptPath: path }, settings, {
        sender: () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() }),
        log: (line) => void logged.push(line),
        lateLinesMs: 0,
        windowBytes: 100_000,
      });
    }
    expect(sent).toHaveLength(2);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('sends nothing without a key, and says so once', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path, { apiKey: undefined });
    await hook('Stop', path, { apiKey: undefined });
    expect(sent).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^no key/);
  });
});

describe('the lock', () => {
  it('lets one hook of a session work at a time, and is free once it is done', async () => {
    const lockDir = join(dir.path, 'locks');
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withLock(lockDir, SESSION, 1000, async () => {
      order.push('first in');
      await held;
      order.push('first out');
    });
    const second = withLock(lockDir, SESSION, 5000, async () => void order.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(['first in', 'first out', 'second']);
    expect(existsSync(join(lockDir, `${SESSION}.lock`))).toBe(false);
  });

  it('gives up past its wait while another holds it', async () => {
    const lockDir = join(dir.path, 'locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `${SESSION}.lock`), '');
    expect(await withLock(lockDir, SESSION, 300, async () => undefined)).toBe(false);
  });
});
