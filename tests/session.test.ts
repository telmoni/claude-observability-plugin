import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord, StepRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Destination, Sender } from '../src/send';
import { type Deps, type HookEvent, sync } from '../src/session';
import type { Settings } from '../src/settings';
import { readState, withLock, writeState } from '../src/state';
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

/** A sender that takes every turn. */
const taking: Deps['sender'] = () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() });

function hook(event: HookEvent, path: string, overrides: Partial<Settings> = {}, more: Partial<Deps> = {}): Promise<void> {
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
    lateLinesMs: 20,
    ...more,
  });
}

const append = (path: string, more: string[]): void =>
  writeFileSync(path, more.map((line) => `${line}\n`).join(''), { flag: 'a' });

/** The reply Claude Code writes as it resumes a session whose last line was no reply, as it writes it. */
const placeholder = (timestamp: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-999999999990',
    timestamp,
    isApiErrorMessage: false,
    message: { id: 'msg_placeholder', model: '<synthetic>', stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: 'No response requested.' }] },
  });

/** A line longer than any window the tests read. */
const huge = JSON.stringify({ type: 'attachment', uuid: 'huge', timestamp: '2026-10-12T09:00:00.000Z', padding: 'x'.repeat(200_000) });

/** The same work as new turns: every id renamed, every time two hours on. */
const renamed = (from: string[]): string[] =>
  from.map((line) =>
    line
      .replaceAll('00000000-0000-4000-8000-', '00000000-0000-4000-9000-')
      .replaceAll('"msg_', '"msg_r')
      .replaceAll('"toolu_', '"toolu_r')
      .replaceAll('T08:', 'T10:')
      .replaceAll('T09:', 'T11:'),
  );

/** Hooks one after another, as a session's go, until one moves the saved place no further. */
async function catchUp(path: string, windowBytes: number): Promise<void> {
  for (let previous = -1; ; ) {
    await sync({ event: 'Stop', sessionId: SESSION, transcriptPath: path }, settings, {
      sender: taking,
      log: (line) => void logged.push(line),
      lateLinesMs: 0,
      windowBytes,
    });
    const { offset } = readState(settings.dir, SESSION);
    if (offset === previous) return;
    previous = offset;
  }
}

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
    await hook('Stop', path, {}, { lateLinesMs: 600 });
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

  it('names an API error Claude Code gives no plain kind `api_error`, never by its text', async () => {
    const [, second] = openings();
    const path = writtenThrough(second! + 1);
    const opener = JSON.parse(lines[second!]!) as { timestamp: string };
    append(path, [
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-999999999997',
        timestamp: new Date(Date.parse(opener.timestamp) + 2000).toISOString(),
        isApiErrorMessage: true,
        error: 'Rate limited: try again in 30 seconds',
        message: { model: '<synthetic>', content: [] },
      }),
    ]);
    await hook('StopFailure', path);
    expect(sent[1]!.errorType).toBe('api_error');
    expect(JSON.stringify(sent)).not.toContain('Rate limited');
  });

  it('sends no run of the reply Claude Code writes as it resumes a session', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    const last = JSON.parse(lines.at(-1)!) as { timestamp: string };
    append(path, [placeholder(new Date(Date.parse(last.timestamp) + 2 * 86_400_000).toISOString())]);
    await hook('SessionEnd', path);
    expect(sent).toHaveLength(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('keeps a turn interrupted before the session was resumed cancelled, ended where it was interrupted', async () => {
    const [, second, third] = openings();
    const asking = lastAsking(second!, third!);
    const path = writtenThrough(asking + 1);
    const at = Date.parse((JSON.parse(lines[asking]!) as { timestamp: string }).timestamp);
    append(path, [
      JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-999999999991', timestamp: new Date(at + 1000).toISOString(), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
      placeholder(new Date(at + 2 * 86_400_000).toISOString()),
    ]);
    await hook('Stop', path);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.cancelled).toBe(true);
    expect(sent[1]!.errorType).toBeUndefined();
    expect(Number(sent[1]!.end)).toBeLessThanOrEqual(at + 1000);
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

  it('sends nothing again when Claude Code writes an old turn again from inside it, as it does from a compaction', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    const [, second] = openings();
    append(path, lines.slice(5, second));
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('reads from the top a transcript rewritten so another line ends just where the last hook stopped', async () => {
    const [, , third] = openings();
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    const stopped = readState(settings.dir, SESSION).offset;
    // Two new turns, then a line that ends exactly where the last hook stopped.
    const before = renamed(lines.slice(0, third)).map((line) => `${line}\n`).join('');
    const bare = JSON.stringify({ type: 'attachment', uuid: '00000000-0000-4000-a000-000000000001', timestamp: '2026-10-12T12:00:00.000Z', padding: '' });
    const padding = stopped - Buffer.byteLength(before) - Buffer.byteLength(bare) - 1;
    expect(padding).toBeGreaterThan(0);
    const filler = JSON.stringify({ ...(JSON.parse(bare) as object), padding: 'x'.repeat(padding) });
    writeFileSync(path, `${before}${filler}\n`);
    expect(readFileSync(path).length).toBe(stopped);
    await hook('Stop', path);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(5);
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

  it('sends a turn again, after the platform did not take it, as the same record, however far on it is read', async () => {
    const [, second] = openings();
    const attempts: RunRecord[] = [];
    const tryHook = (path: string, answer: boolean): Promise<void> =>
      sync({ event: 'Stop', sessionId: SESSION, transcriptPath: path }, settings, {
        sender: () => ({ send: (record) => (attempts.push(record), Promise.resolve(answer)), close: () => Promise.resolve() }),
        log: (line) => void logged.push(line),
        lateLinesMs: 0,
      });
    // At its stop, the summary Claude Code writes after its hooks is not there yet.
    const path = writtenThrough(second! - 1);
    await tryHook(path, false);
    writtenThrough(lines.length);
    await tryHook(path, true);
    expect(attempts).toHaveLength(4);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('reads a turn whose lines Claude Code wrote again while it went on as the one turn, losing nothing after', async () => {
    const [, second] = openings();
    const middle = 60;
    const path = writtenThrough(second!);
    await hook('Stop', path);
    const clean = sent.splice(0);
    settings = { ...settings, dir: join(dir.path, 'telmoni-again') };
    // The turn so far written again, ids and all, as Claude Code does, then the rest of it.
    writtenThrough(middle);
    append(path, [...lines.slice(0, middle), ...lines.slice(middle, second)]);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.inside).toEqual(clean[0]!.inside);
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
    await catchUp(path, windowBytes);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('reads on to the transcript’s end as the session ends, there being no hook after', async () => {
    const path = writtenThrough(lines.length);
    await sync({ event: 'SessionEnd', sessionId: SESSION, transcriptPath: path }, settings, {
      sender: taking,
      log: (line) => void logged.push(line),
      lateLinesMs: 0,
      windowBytes: 10_000,
    });
    expect(sent).toHaveLength(3);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('sends a turn longer than a window as one run, the window grown until it holds the turn', async () => {
    const path = writtenThrough(lines.length);
    await catchUp(path, 1024 * 1024);
    const whole = sent.splice(0);
    settings = { ...settings, dir: join(dir.path, 'telmoni-again') };
    await catchUp(path, 10_000);
    expect(sent.map((run) => [run.runId, run.inside?.length])).toEqual(whole.map((run) => [run.runId, run.inside?.length]));
  });

  it('sends a turn longer than the most a hook reads in parts, rather than never', async () => {
    const path = writtenThrough(lines.length);
    await catchUp(path, 2_000);
    expect(sent.length).toBeGreaterThan(3);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(sent.length);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('catches up old lines written again across windows, each turn once', async () => {
    const [, second] = openings();
    const path = writtenThrough(lines.length);
    // As Claude Code writes a session's lines again, ids and all, then goes on.
    append(path, lines.slice(second));
    append(path, renamed(lines.slice(second)));
    await catchUp(path, 10_000);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(5);
  });

  it('reads from the top a transcript rewritten under its saved place, sending only what it never sent', async () => {
    const [, , third] = openings();
    const path = writtenThrough(lines.length);
    await hook('Stop', path);
    expect(sent).toHaveLength(3);
    // Rewritten, not appended to: old turns trimmed, two new ones after, the file no smaller than where the last hook stopped.
    const rewritten = [...lines.slice(third), ...renamed(lines.slice(0, third)), lines[1]!];
    writeFileSync(path, rewritten.map((line) => `${line}\n`).join(''));
    expect(readFileSync(path).length).toBeGreaterThanOrEqual(readState(settings.dir, SESSION).offset);
    await hook('Stop', path);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((run) => run.runId)).size).toBe(5);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('passes over a line longer than a window, as it does a line it cannot read', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(second!);
    append(path, [huge, ...lines.slice(second, third)]);
    for (let hook = 0; hook < 6; hook++) {
      await sync({ event: 'Stop', sessionId: SESSION, transcriptPath: path }, settings, {
        sender: taking,
        log: (line) => void logged.push(line),
        lateLinesMs: 0,
        windowBytes: 100_000,
      });
    }
    expect(sent).toHaveLength(2);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('passes over a line longer than a window that it opens', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(second!);
    await catchUp(path, 100_000);
    expect(sent).toHaveLength(1);
    append(path, [huge, ...lines.slice(second, third)]);
    await catchUp(path, 100_000);
    expect(sent).toHaveLength(2);
    expect(readState(settings.dir, SESSION).offset).toBe(readFileSync(path).length);
  });

  it('reads on past a line a crash tore, before a line longer than a window', async () => {
    const [, second, third] = openings();
    const path = writtenThrough(second!);
    await catchUp(path, 100_000);
    append(path, ['{"type":"user","uuid":"torn', huge, ...lines.slice(second, third)]);
    await catchUp(path, 100_000);
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
    expect(readState(settings.dir, SESSION).warnedNoKey).toBe(true);
  });

  it('logs a missing key only under the session’s lock, so no hook’s save is written over', async () => {
    const path = writtenThrough(lines.length);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    await hook('Stop', path, { apiKey: undefined }, { lockWaitMs: 10 });
    expect(logged).toEqual(['busy: another hook of this session held the lock past its wait; the next hook sends']);
    release();
    await holder;
    await hook('Stop', path, { apiKey: undefined });
    expect(logged.at(-1)).toMatch(/^no key/);
  });

  it('waits on no lock to say again what it said already', async () => {
    const path = writtenThrough(lines.length);
    await hook('Stop', path, { apiKey: undefined });
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    await hook('Stop', path, { apiKey: undefined }, { lockWaitMs: 60_000 });
    release();
    await holder;
    expect(logged).toEqual([expect.stringMatching(/^no key/) as unknown]);
  });

  it('names an endpoint the SDK refuses once, in the SDK’s own words, and sends nothing', async () => {
    const path = writtenThrough(lines.length);
    const real = { sender: (destination: Destination) => new Sender(destination, (line) => void logged.push(line)) };
    await hook('Stop', path, { endpoint: 'http://telmoni.example.com' }, real);
    await hook('Stop', path, { endpoint: 'http://telmoni.example.com' }, real);
    expect(logged).toEqual([
      "endpoint refused by the SDK (refusing to send the API key over unencrypted HTTP to 'telmoni.example.com'; use HTTPS): set another with /plugin configure, or TELMONI_ENDPOINT; nothing is sent until then",
    ]);
    expect(readState(settings.dir, SESSION)).toMatchObject({ offset: 0, warnedEndpoint: true });
  });
});

describe('the state', () => {
  it('starts afresh only where none was saved, and throws on one it cannot read rather than send the session again', () => {
    expect(readState(settings.dir, SESSION)).toEqual({ offset: 0 });
    mkdirSync(settings.dir, { recursive: true });
    for (const unreadable of ['{"offset":', '', 'null', '[]']) {
      writeFileSync(join(settings.dir, `${SESSION}.json`), unreadable);
      expect(() => readState(settings.dir, SESSION)).toThrow();
    }
  });

  it('is written through a file named for its own process, leaving any other writer’s alone', () => {
    mkdirSync(settings.dir, { recursive: true });
    const others = [`${SESSION}.json.tmp`, `${SESSION}.json.${process.pid + 1}.tmp`].map((name) => join(settings.dir, name));
    for (const other of others) writeFileSync(other, 'theirs');
    writeState(settings.dir, SESSION, { offset: 7 });
    expect(others.map((other) => readFileSync(other, 'utf8'))).toEqual(['theirs', 'theirs']);
    expect(readState(settings.dir, SESSION)).toEqual({ offset: 7 });
  });
});

describe('a turn whose subagent works on in the background', () => {
  const subagentPath = (): string => join(dir.path, SESSION, 'subagents', 'agent-01.jsonl');
  const subagentLines = (): string[] =>
    readFileSync(`${fixture('subagent').replace(/\.jsonl$/, '')}/subagents/agent-01.jsonl`, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');

  /** The subagent's transcript as Claude Code had written it by the time the turn that started it ended. */
  function subagentSoFar(): void {
    const [, second] = openings();
    const turnEnded = Date.parse((JSON.parse(lines[second! - 1]!) as { timestamp: string }).timestamp);
    const soFar = subagentLines().filter((line) => Date.parse((JSON.parse(line) as { timestamp: string }).timestamp) <= turnEnded);
    expect(soFar.length).toBeLessThan(subagentLines().length);
    writeFileSync(subagentPath(), soFar.map((line) => `${line}\n`).join(''));
  }

  /** The calls in the subagent's whole transcript, counted apart from the plugin: a model call per reply, a tool call per tool. */
  function subagentCalls(): number {
    const replies = new Set<string>();
    let tools = 0;
    for (const line of subagentLines()) {
      const entry = JSON.parse(line) as { type?: string; message?: { id?: string; content?: Array<{ type?: string }> } };
      if (entry.type !== 'assistant') continue;
      if (entry.message?.id !== undefined) replies.add(entry.message.id);
      tools += (entry.message?.content ?? []).filter((block) => block.type === 'tool_use').length;
    }
    return replies.size + tools;
  }

  const stepOf = (run: RunRecord): StepRecord => run.inside!.find((item): item is StepRecord => item.type === 'step')!;

  it('is sent once its subagent has finished, holding all of the subagent’s work', async () => {
    const [, second, third] = openings();
    subagentSoFar();
    const path = writtenThrough(second!);
    await hook('Stop', path);
    expect(sent).toEqual([]);
    expect(readState(settings.dir, SESSION).offset).toBe(0);
    // The subagent finishes, and the notice it sends opens a turn of its own.
    writeFileSync(subagentPath(), subagentLines().map((line) => `${line}\n`).join(''));
    writtenThrough(third!);
    await hook('Stop', path);
    expect(sent).toHaveLength(2);
    expect(stepOf(sent[0]!).calls).toHaveLength(subagentCalls());
    expect(stepOf(sent[0]!).cancelled).toBeUndefined();
    expect(Number(sent[0]!.end)).toBeGreaterThanOrEqual(Number(stepOf(sent[0]!).end));
  });

  it('is sent as the session ends, its subagent cut off, and the turns after it too, however many windows on', async () => {
    subagentSoFar();
    const path = writtenThrough(lines.length);
    await sync({ event: 'SessionEnd', sessionId: SESSION, transcriptPath: path }, settings, {
      sender: taking,
      log: (line) => void logged.push(line),
      lateLinesMs: 0,
      windowBytes: 40_000,
    });
    expect(sent).toHaveLength(3);
    expect(stepOf(sent[0]!).cancelled).toBe(true);
    expect(stepOf(sent[0]!).calls!.length).toBeLessThan(subagentCalls());
  });

  it('holds, of a subagent resumed in a later turn, only the run the turn started', async () => {
    const [, second] = openings();
    const resumed = [...subagentLines()];
    const last = JSON.parse(resumed.at(-1)!) as { timestamp: string };
    const later = (seconds: number): string => new Date(Date.parse(last.timestamp) + seconds * 1000).toISOString();
    resumed.push(
      JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-9000-000000000001', timestamp: later(60), isSidechain: true, message: { content: '…' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-4000-9000-000000000002',
        timestamp: later(70),
        isSidechain: true,
        message: { id: 'msg_resumed', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_resumed', name: 'Bash' }] },
      }),
    );
    writeFileSync(subagentPath(), resumed.map((line) => `${line}\n`).join(''));
    const path = writtenThrough(second!);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    expect(stepOf(sent[0]!).calls).toHaveLength(subagentCalls());
    expect(stepOf(sent[0]!).cancelled).toBeUndefined();
  });

  it('is not held by a subagent that has written nothing for half an hour', async () => {
    const [, second] = openings();
    subagentSoFar();
    const long = new Date(Date.now() - 31 * 60_000);
    utimesSync(subagentPath(), long, long);
    const path = writtenThrough(second!);
    await hook('Stop', path);
    expect(sent).toHaveLength(1);
    expect(stepOf(sent[0]!).cancelled).toBe(true);
  });

  /** The subagent's transcript with a reply cut off at its output's limit before its first, and, unless `alone`, Claude Code's word to go on. */
  function cutOff(alone = false): void {
    const original = subagentLines();
    const first = original.findIndex((line) => (JSON.parse(line) as { type?: string }).type === 'assistant');
    const timestamp = (JSON.parse(original[first]!) as { timestamp: string }).timestamp;
    const cut = [
      JSON.stringify({ type: 'assistant', uuid: '00000000-0000-4000-9000-000000000003', timestamp, isSidechain: true, message: { id: 'msg_cut', model: 'claude-opus-5-5', stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: '…' }] } }),
      JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-9000-000000000004', timestamp, isSidechain: true, isMeta: true, turnCompanion: true, message: { content: 'Output token limit hit. Resume directly' } }),
    ];
    const written = alone ? [...original.slice(0, first), cut[0]!] : [...original.slice(0, first), ...cut, ...original.slice(first)];
    writeFileSync(subagentPath(), written.map((line) => `${line}\n`).join(''));
  }

  it('holds all of a subagent’s run that went on past a reply cut off at its output’s limit', async () => {
    cutOff();
    await hook('Stop', writtenThrough(lines.length));
    expect(sent).toHaveLength(3);
    expect(stepOf(sent[0]!).calls).toHaveLength(subagentCalls() + 1);
    expect(stepOf(sent[0]!).cancelled).toBeUndefined();
  });

  it('is held while a subagent cut off at its output’s limit has yet to go on', async () => {
    const [, second] = openings();
    cutOff(true);
    await hook('Stop', writtenThrough(second!));
    expect(sent).toEqual([]);
  });

  /** The subagent's transcript up to its first reply, then `more`. */
  function subagentThen(more: object[]): void {
    const original = subagentLines();
    const first = original.findIndex((line) => (JSON.parse(line) as { type?: string }).type === 'assistant');
    const timestamp = (JSON.parse(original[first]!) as { timestamp: string }).timestamp;
    const lines = more.map((line, index) => JSON.stringify({ uuid: `00000000-0000-4000-9000-00000000010${index}`, timestamp, isSidechain: true, ...line }));
    writeFileSync(subagentPath(), [...original.slice(0, first), ...lines].map((line) => `${line}\n`).join(''));
  }

  it('holds a subagent’s run past a reply a classifier cut off, its calls not run, and the word to go on', async () => {
    const usage = { input_tokens: 5, output_tokens: 5 };
    subagentThen([
      { type: 'assistant', message: { id: 'msg_refused', model: 'claude-opus-5-5', stop_reason: 'refusal', usage, content: [{ type: 'tool_use', id: 'toolu_refused', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_refused', is_error: true, content: 'Not run' }] } },
      { type: 'user', isMeta: true, turnCompanion: true, message: { content: 'Your response above was stopped by a safety classifier' } },
      { type: 'assistant', message: { id: 'msg_after', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '…' }] } },
    ]);
    await hook('Stop', writtenThrough(lines.length));
    expect(sent).toHaveLength(3);
    expect(stepOf(sent[0]!).calls!.filter((call) => call.type === 'model_call')).toHaveLength(2);
    expect(stepOf(sent[0]!).cancelled).toBeUndefined();
  });

  it('ends a subagent’s run at a refusal Claude Code gave up on, an API error, though the main agent writes to it after', async () => {
    subagentThen([
      { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', message: { model: '<synthetic>', stop_reason: 'refusal', content: [] } },
      { type: 'user', isMeta: true, origin: { kind: 'coordinator' }, message: { content: '…' } },
      { type: 'assistant', message: { id: 'msg_resumed', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_resumed', name: 'Bash' }] } },
    ]);
    const [, second] = openings();
    await hook('Stop', writtenThrough(second!));
    expect(sent).toHaveLength(1);
    expect(stepOf(sent[0]!).calls!.some((call) => call.type === 'tool_call' && call.name === 'Bash')).toBe(false);
  });

  it('ends a subagent’s run at a refusal Claude Code gave up on, its last line', async () => {
    subagentThen([{ type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', message: { model: '<synthetic>', stop_reason: 'refusal', content: [] } }]);
    const [, second] = openings();
    await hook('Stop', writtenThrough(second!));
    expect(sent).toHaveLength(1);
  });

  it('is held while a subagent stopped at the context window’s end has yet to go on', async () => {
    const [, second] = openings();
    subagentThen([{ type: 'assistant', message: { id: 'msg_full', model: 'claude-opus-5-5', stop_reason: 'model_context_window_exceeded', content: [{ type: 'text', text: '…' }] } }]);
    await hook('Stop', writtenThrough(second!));
    expect(sent).toEqual([]);
  });
});

describe('the lock', () => {
  it('is given up past its wait at a stop, which a later hook follows, and outwaited at the session’s end', async () => {
    const path = writtenThrough(lines.length);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withLock(settings.dir, SESSION, 1000, async () => {
      entered();
      await held;
    });
    await inside;
    let ended = false;
    const ending = hook('SessionEnd', path, {}, { lockWaitMs: 10 }).then(() => {
      ended = true;
    });
    await hook('Stop', path, {}, { lockWaitMs: 10 });
    expect(logged).toEqual(['busy: another hook of this session held the lock past its wait; the next hook sends']);
    // The stop gave up after the session's end began to wait, and that waits on.
    expect(ended).toBe(false);
    release();
    await Promise.all([holder, ending]);
    expect(sent).toHaveLength(3);
    expect(logged).toHaveLength(1);
  });

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

  it('is never taken for a dead hook’s while its hook works on past the time that takes', async () => {
    const lockDir = join(dir.path, 'locks');
    const order: string[] = [];
    const staleMs = 1_000;
    const first = withLock(
      lockDir,
      SESSION,
      1000,
      async () => {
        order.push('first in');
        await new Promise((resolve) => setTimeout(resolve, staleMs * 3));
        order.push('first out');
      },
      staleMs,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = withLock(lockDir, SESSION, staleMs * 6, async () => void order.push('second'), staleMs);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });

  it('leaves in place a lock another hook took from it', async () => {
    const lockDir = join(dir.path, 'locks');
    const lock = join(lockDir, `${SESSION}.lock`);
    await withLock(lockDir, SESSION, 1000, async () => {
      // Another hook, finding this one's lock stale, took it.
      writeFileSync(lock, 'another hook');
    });
    expect(readFileSync(lock, 'utf8')).toBe('another hook');
  });

  it('is taken from a hook that died, once untouched past its stale time, and holds the taker’s own token', async () => {
    const lockDir = join(dir.path, 'locks');
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, `${SESSION}.lock`);
    writeFileSync(lock, '1:a-dead-hook');
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(lock, old, old);
    let token = '';
    expect(await withLock(lockDir, SESSION, 1000, async () => void (token = readFileSync(lock, 'utf8')))).toBe(true);
    expect(token).toMatch(new RegExp(`^${process.pid}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    expect(existsSync(lock)).toBe(false);
  });

  it('is kept in a folder only its owner can open, readable by its owner alone', async () => {
    const lockDir = join(dir.path, 'locks');
    let mode = 0;
    await withLock(lockDir, SESSION, 1000, async () => {
      mode = statSync(join(lockDir, `${SESSION}.lock`)).mode & 0o777;
    });
    expect(mode).toBe(0o600);
    expect(statSync(lockDir).mode & 0o777).toBe(0o700);
  });
});
