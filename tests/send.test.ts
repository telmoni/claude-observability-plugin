import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sender } from '../src/send';
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
