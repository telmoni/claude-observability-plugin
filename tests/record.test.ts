import { readFileSync } from 'node:fs';

import type { ModelCallRecord, RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import { type Context, AGENT, recordOf, uuid5 } from '../src/record';
import { subagentsOf } from '../src/session';
import { type Entry, isMarked, readLines, segments } from '../src/transcript';
import { fixture } from './helpers';

function runsOf(name: string, sessionEnded = false): RunRecord[] {
  const path = fixture(name);
  const lines = readLines(path, 0);
  const context: Context = { sessionId: 'session-1', provider: 'anthropic', subagent: subagentsOf(path), sessionEnded };
  return segments(lines, isMarked(lines)).flatMap((segment) => recordOf(segment, context) ?? []);
}

/** The fixture's replies by id, counted independently of the plugin. */
function replies(path: string): Map<string, { input: number; output: number; read: number; write: number }> {
  const out = new Map<string, { input: number; output: number; read: number; write: number }>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as Entry;
    const message = entry.message;
    if (entry.type !== 'assistant' || message?.model === '<synthetic>' || typeof message?.id !== 'string') continue;
    const usage = message.usage ?? {};
    out.set(message.id, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      read: usage.cache_read_input_tokens ?? 0,
      write: usage.cache_creation_input_tokens ?? 0,
    });
  }
  return out;
}

function modelCalls(runs: RunRecord[]): ModelCallRecord[] {
  return runs.flatMap((run) =>
    (run.inside ?? []).flatMap((item) =>
      item.type === 'step' ? (item.calls ?? []).filter((c) => c.type === 'model_call') : item.type === 'model_call' ? [item] : [],
    ),
  ) as ModelCallRecord[];
}

describe('a turn as a run', () => {
  it('is a run of claude-code in the session, its id the same every time it is read', () => {
    const runs = runsOf('subagent');
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run.agent).toBe(AGENT);
      expect(run.sessionId).toBe('session-1');
      expect(run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Number(run.end)).toBeGreaterThanOrEqual(Number(run.start));
    }
    expect(new Set(runs.map((run) => run.runId)).size).toBe(3);
    expect(runsOf('subagent')).toEqual(runs);
  });

  it('has a model call per reply, however many lines it was written in, with tokens as the conventions count them', () => {
    const main = replies(fixture('subagent'));
    const inner = replies(`${fixture('subagent').replace(/\.jsonl$/, '')}/subagents/agent-01.jsonl`);
    const calls = modelCalls(runsOf('subagent'));
    expect(calls).toHaveLength(main.size + inner.size);
    const expected = [...main.values(), ...inner.values()].map((u) => u.input + u.read + u.write).sort((a, b) => a - b);
    expect(calls.map((call) => call.usage!.inputTokens!).sort((a, b) => a - b)).toEqual(expected);
    for (const call of calls) {
      expect(call.provider).toBe('anthropic');
      expect(call.usage!.inputTokens).toBeGreaterThanOrEqual(call.usage!.cacheReadInputTokens! + call.usage!.cacheWriteInputTokens!);
      expect(Number(call.end)).toBeGreaterThanOrEqual(Number(call.start));
    }
  });

  it('holds a subagent as a step of its own calls, named by its kind', () => {
    const steps = runsOf('subagent').flatMap((run) => (run.inside ?? []).filter((item): item is StepRecord => item.type === 'step'));
    expect(steps.map((step) => step.name)).toEqual(['subagent Explore']);
    const step = steps[0]!;
    expect((step.calls ?? []).length).toBeGreaterThan(0);
    for (const call of step.calls ?? []) expect(Number(call.start)).toBeGreaterThanOrEqual(Number(step.start));
    const lastCall = Math.max(...(step.calls ?? []).map((call) => Number(call.end)));
    expect(Number(step.end)).toBeGreaterThanOrEqual(lastCall);
  });

  it('marks an interrupted turn cancelled, a failed tool failed, and tags the skills it ran by name', () => {
    const [run] = runsOf('interrupted');
    expect(run!.cancelled).toBe(true);
    expect(run!.errorType).toBeUndefined();
    expect(run!.tags).toEqual({ skills: 'skill-a' });
    const tools = (run!.inside ?? []).filter((item): item is ToolCallRecord => item.type === 'tool_call');
    expect(tools.map((tool) => [tool.name, tool.errorType])).toEqual([['Skill', 'ToolError']]);
  });

  it('marks a turn whose last reply is Claude Code’s own error failed with its kind', () => {
    const at = (s: number): string => new Date(Date.UTC(2026, 9, 12, 9, 0, s)).toISOString();
    const entries: Entry[] = [
      { type: 'user', uuid: 'p', timestamp: at(0), turnPosition: {}, message: { content: '…' } },
      { type: 'assistant', uuid: 'e', timestamp: at(3), isApiErrorMessage: true, error: 'rate_limit', message: { model: '<synthetic>', content: [] } },
    ];
    const run = recordOf(
      { opener: entries[0], entries, end: 0 },
      { sessionId: 's', provider: 'anthropic', subagent: () => undefined, sessionEnded: false },
    )!;
    expect(run.errorType).toBe('rate_limit');
    expect(run.inside).toEqual([]);
    expect(Number(run.end) - Number(run.start)).toBe(3000);
  });

  it('takes a reply’s tokens from its last line, the lines before holding the counts so far', () => {
    const at = (s: number): string => new Date(Date.UTC(2026, 9, 12, 9, 0, s)).toISOString();
    const line = (uuid: string, s: number, output: number, stop: string | null): Entry => ({
      type: 'assistant',
      uuid,
      timestamp: at(s),
      message: { id: 'm1', model: 'claude-haiku-4-5', stop_reason: stop, usage: { input_tokens: 10, output_tokens: output }, content: [] },
    });
    const entries: Entry[] = [
      { type: 'user', uuid: 'p', timestamp: at(0), turnPosition: {}, message: { content: '…' } },
      line('a1', 1, 1, null),
      line('a2', 2, 50, 'end_turn'),
    ];
    const run = recordOf(
      { opener: entries[0], entries, end: 0 },
      { sessionId: 's', provider: 'anthropic', subagent: () => undefined, sessionEnded: false },
    )!;
    expect(run.inside).toHaveLength(1);
    const call = run.inside![0] as ModelCallRecord;
    expect(call.usage!.outputTokens).toBe(50);
    expect([Number(call.start), Number(call.end)]).toEqual([Date.parse(at(0)), Date.parse(at(2))]);
  });

  it('carries nothing of what was said: no text, no input, no path', () => {
    const records = JSON.stringify([...runsOf('subagent'), ...runsOf('interrupted')]);
    expect(records).not.toContain('…');
    expect(records).not.toContain('/');
    const keys = new Set<string>();
    JSON.parse(records, (key, value: unknown) => {
      if (key !== '' && Number.isNaN(Number(key))) keys.add(key);
      return value;
    });
    expect([...keys].sort()).toEqual(
      [
        'agent',
        'cacheReadInputTokens',
        'cacheWriteInputTokens',
        'calls',
        'cancelled',
        'end',
        'errorType',
        'inputTokens',
        'inside',
        'model',
        'name',
        'outputTokens',
        'provider',
        'runId',
        'sessionId',
        'skills',
        'start',
        'tags',
        'type',
        'usage',
      ].sort(),
    );
  });
});

describe('a run id', () => {
  it('is a version 5 UUID as RFC 9562 derives one', () => {
    // RFC 9562's own example: the DNS namespace and "www.example.com".
    expect(uuid5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});
