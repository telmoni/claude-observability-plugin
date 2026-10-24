import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name: string): string {
  return join(FIXTURES, name, 'session.jsonl');
}

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'telmoni-claude-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code: number };
}

export interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Ingest as the SDK meets it: an OTLP/JSON lane that keeps what it is sent, answers `status` or takes it in part
 * (`partial`), and stores a body once.
 */
export class FakeIngest {
  readonly received: Received[] = [];
  readonly stored = new Set<string>();
  status = 200;
  /** Statuses to answer first, one a request, before `status`; a refusal given with its problem type is answered with it. */
  readonly answers: Array<number | { status: number; type: string }> = [];
  partial: string | undefined;
  #server: Server | undefined;

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.received.push({ url: request.url ?? '', headers: request.headers, body });
        const answer = this.answers.shift() ?? this.status;
        const status = typeof answer === 'number' ? answer : answer.status;
        if (status === 200) {
          this.stored.add(body);
          const partialSuccess =
            this.partial === undefined ? null : { rejectedSpans: 1, errorMessage: this.partial };
          response.writeHead(200, { 'Content-Type': 'application/json', 'Telmoni-Content-Mode': 'off' });
          response.end(JSON.stringify({ partialSuccess }));
        } else {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          const message = typeof answer === 'number' ? '/errors/authz/forbidden: this API key does not hold the ingest scope' : answer.type;
          response.end(JSON.stringify({ code: 7, message }));
        }
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  spans(): JsonSpan[] {
    return this.received.flatMap((request) => {
      const body = JSON.parse(request.body) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: JsonSpan[] }> }>;
      };
      return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    });
  }
}

export function attributesOf(span: JsonSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of span.attributes) {
    const value = attribute.value;
    out[attribute.key] = 'intValue' in value ? Number(value['intValue']) : Object.values(value)[0];
  }
  return out;
}
