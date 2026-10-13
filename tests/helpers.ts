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

/** Ingest as the SDK meets it: an OTLP/JSON lane that keeps what it is sent, or answers `status`. */
export class FakeIngest {
  readonly received: Received[] = [];
  status = 200;
  #server: Server | undefined;

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.received.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (this.status === 200) {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Telmoni-Content-Mode': 'off' });
          response.end(JSON.stringify({ partialSuccess: null }));
        } else {
          response.writeHead(this.status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 7, message: '/errors/authz/forbidden: this API key does not hold the ingest scope' }));
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
