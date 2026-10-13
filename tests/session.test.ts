import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord, StepRecord } from 'telmoni';
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
      sender: () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() }),
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
      sender: () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() }),
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
    // Rewritten, not appended to: its old turns trimmed, two new ones after,
    // and the file no smaller than where the last hook stopped.
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

  /** The calls in the subagent's whole transcript, counted apart from the plugin: a model call per reply, a tool call per tool asked for. */
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
      sender: () => ({ send: (record) => (sent.push(record), Promise.resolve(true)), close: () => Promise.resolve() }),
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
