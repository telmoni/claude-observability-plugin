/**
 * Sends a session's finished turns through the TypeScript SDK, one export
 * each: a turn sent again — after a hook that died before saving that it had
 * sent it — is then the same bytes, which ingest answers once.
 */

import { Telmoni } from 'telmoni';
import type { RunRecord } from 'telmoni';

/** How long one turn's export may take, its retries included. */
const FLUSH_SECONDS = 45;

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

export class Sender {
  readonly #telmoni: Telmoni;
  readonly #warnings: string[] = [];
  readonly #log: (line: string) => void;

  constructor(destination: Destination, log: (line: string) => void) {
    this.#log = log;
    this.#telmoni = new Telmoni(
      { endpoint: destination.endpoint, apiKey: destination.apiKey },
      { warn: (message) => void this.#warnings.push(message) },
    );
  }

  /**
   * Whether the platform took the turn. The SDK warns of every export it
   * could not deliver and every span refused, and its warnings never carry a
   * session's content, so a turn counts as taken when its flush settles with
   * no warning. A record the SDK refuses counts as done: it would be refused
   * again on every hook, and must not hold up the turns after it.
   */
  async send(record: RunRecord): Promise<boolean> {
    try {
      this.#telmoni.recordRun(record);
    } catch (error) {
      this.#log(`turn refused by the SDK: ${error instanceof Error ? error.name : typeof error}`);
      return true;
    }
    const flushed = await this.#telmoni.flush(FLUSH_SECONDS);
    if (flushed && this.#warnings.length === 0) return true;
    this.#log(flushed ? `not sent: ${this.#warnings.join('; ')}` : 'not sent: the export did not finish in time');
    return false;
  }

  close(): Promise<void> {
    return this.#telmoni.shutdown();
  }
}
