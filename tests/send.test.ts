import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sender, flushSecondsOf } from '../src/send';
import { FakeIngest, attributesOf } from './helpers';

let ingest: FakeIngest;
let endpoint: string;
let logged: string[];

beforeEach(async () => {
  ingest = new FakeIngest();
  endpoint = await ingest.start();
  logged = [];
});

afterEach(async () => {
  await ingest.stop();
});

const at = (seconds: number): number => Date.UTC(2026, 9, 12, 9, 0, seconds);

function turn(runId: string): RunRecord {
  return {
    runId,
    agent: 'claude-code',
    sessionId: 'session-1',
    start: at(0),
    end: at(9),
    inside: [
      {
        type: 'model_call',
        model: 'claude-opus-5-5',
        provider: 'anthropic',
        start: at(0),
        end: at(4),
        usage: { inputTokens: 1300, outputTokens: 40, cacheReadInputTokens: 1000, cacheWriteInputTokens: 200 },
      },
      { type: 'tool_call', name: 'Bash', start: at(4), end: at(9), errorType: 'ToolError' },
    ],
  };
}

describe('a sender', () => {
  it('sends each turn in an export of its own, through the SDK, to ingest', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(2);
    for (const request of ingest.received) {
      expect(request.url).toBe('/otlp/v1/traces');
      expect(request.headers['authorization']).toBe('Bearer telmoni_test');
    }
    const runs = ingest.spans().filter((span) => span.name === 'invoke_agent claude-code');
    expect(runs.map((span) => attributesOf(span)['gen_ai.conversation.id'])).toEqual(['session-1', 'session-1']);
    const call = ingest.spans().find((span) => span.name === 'chat claude-opus-5-5')!;
    expect(attributesOf(call)['gen_ai.usage.input_tokens']).toBe(1300);
    expect(logged).toEqual([]);
  });

  it('reports a turn the platform refused as not sent, naming why', async () => {
    ingest.status = 403;
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^not sent: .*403/);
    expect(logged[0]).not.toContain('telmoni_test');
    expect(logged[0]).not.toContain(endpoint);
  });

  it('counts a turn the platform took in part as taken, naming what it refused, since sent again it is refused again', async () => {
    ingest.partial = 'span 0f0f0f0f0f0f0f0f refused: name over its cap';
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(1);
    expect(logged).toEqual(['taken in part: telmoni: the server refused a span: name over its cap']);
  });

  it('counts a turn the SDK sent less a field it could not take as taken, rather than send it again at every hook', async () => {
    const call = { type: 'model_call' as const, model: 'claude-opus-5-5', provider: 'anthropic', start: at(0), end: at(4), usage: { inputTokens: -1 } };
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: [call] })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(1);
    expect(logged).toEqual(['taken in part: telmoni: gen_ai.usage.input_tokens must be a whole number from 0 within 64 bits; the call is sent without it']);
  });

  it('passes over a turn refused for good, which the same bytes would get again, and keeps one refused for its key', async () => {
    for (const status of [400, 402, 413, 500, 401]) {
      ingest.status = status;
      const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
      try {
        expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(status !== 401);
      } finally {
        await sender.close();
      }
    }
    expect(logged.map((line) => line.slice(0, line.indexOf(' /')))).toEqual([
      ...[400, 402, 413, 500].map((status) => `refused, not sent again: telmoni: export refused with ${status}`),
      'not sent: telmoni: export refused with 401',
    ]);
  });

  it('keeps a turn ingest refused for a fault of its database, which a later hook may find mended', async () => {
    ingest.answers.push({ status: 500, type: '/errors/internal/database' });
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual(['not sent: telmoni: export refused with 500 /errors/internal/database; the batch was dropped']);
  });

  it('hears each turn’s refusal, so one refused as the turn before it is never read as taken', async () => {
    ingest.answers.push(400, 400, { status: 500, type: '/errors/internal/unknown' }, { status: 500, type: '/errors/internal/database' });
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
      expect(await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'))).toBe(true);
      expect(await sender.send(turn('5f8a0c3e-7d4b-4c9a-8e2f-0a1b2c3d4e5f'))).toBe(true);
      expect(await sender.send(turn('6a9b1d4f-8e5c-4dab-9f3a-1b2c3d4e5f6a'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual([
      expect.stringMatching(/^refused, not sent again: telmoni: export refused with 400 /) as unknown,
      expect.stringMatching(/^refused, not sent again: telmoni: export refused with 400 /) as unknown,
      'refused, not sent again: telmoni: export refused with 500 /errors/internal/unknown; the batch was dropped',
      'not sent: telmoni: export refused with 500 /errors/internal/database; the batch was dropped',
    ]);
  });

  it('keeps a turn one of whose exports was refused for good and another never delivered', async () => {
    const record = turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d');
    const tools = Array.from({ length: 600 }, (_, index) => ({ type: 'tool_call' as const, name: 'Read', start: at(4) + index, end: at(4) + index + 1 }));
    // Two exports, of 512 spans and of the rest: the first refused for good, the second busy past every attempt.
    ingest.answers.push(400, 503, 503, 503);
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line), { sleep: () => Promise.resolve() });
    try {
      expect(await sender.send({ ...record, inside: [...record.inside!, ...tools] })).toBe(false);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(4);
    expect(logged).toEqual([expect.stringMatching(/^not sent: telmoni: export failed after 3 attempts \(503/) as unknown]);
  });

  it('gives a turn’s flush the SDK’s worst case for each batch of 512 spans, a step’s calls among them, and half a minute more', () => {
    const call = (index: number) => ({ type: 'tool_call' as const, name: 'Read', start: at(1) + index, end: at(2) });
    const calls = (count: number): RunRecord => ({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: Array.from({ length: count }, (_, index) => call(index)) });
    expect([0, 510, 511, 3_000].map((count) => flushSecondsOf(calls(count)))).toEqual([180, 180, 330, 930]);
    const step = { type: 'step' as const, name: 'subagent Explore', start: at(1), end: at(2), calls: Array.from({ length: 600 }, (_, index) => call(index)) };
    expect(flushSecondsOf({ ...turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'), inside: [step] })).toBe(330);
  });

  it('sends a turn of more spans than the SDK queues by default, whole', async () => {
    const record = turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d');
    const tools = Array.from({ length: 2_500 }, (_, index) => ({
      type: 'tool_call' as const,
      name: 'Read',
      start: at(4) + index,
      end: at(4) + index + 1,
    }));
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...record, end: at(9) + 3_000, inside: [...record.inside!, ...tools] })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual([]);
    expect(ingest.spans()).toHaveLength(2 + 2 + 2_500);
  });

  it('sends a turn again once Telmoni is back, the same bytes, stored once', async () => {
    ingest.status = 503;
    const quick = { sleep: () => Promise.resolve() };
    const down = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line), quick);
    try {
      expect(await down.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await down.close();
    }
    expect(logged).toEqual([expect.stringMatching(/^not sent: .*503/)]);
    ingest.status = 200;
    const back = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line), quick);
    try {
      expect(await back.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(true);
    } finally {
      await back.close();
    }
    expect(new Set(ingest.received.map((request) => request.body)).size).toBe(1);
    expect(ingest.stored.size).toBe(1);
  });

  it('passes over a turn the SDK refuses, rather than hold the session up on it', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
  });
});
