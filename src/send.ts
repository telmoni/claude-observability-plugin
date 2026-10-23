/**
 * Sends a session's finished turns through the TypeScript SDK, one export
 * each: a turn sent again — after a hook that died before saving that it had
 * sent it — is then the same bytes, which ingest answers once.
 */

import { Telmoni } from 'telmoni';
import type { Hooks, RunRecord } from 'telmoni';

/** The most spans the SDK sends in one export; it sends a turn's exports one after another. */
const BATCH_SPANS = 512;
/** How many times the SDK sends one export before it drops the batch. */
const ATTEMPTS = 3;
/** How long the SDK gives each attempt. */
const ATTEMPT_SECONDS = 10;
/** The longest `Retry-After` the SDK waits between two attempts. */
const RETRY_WAIT_SECONDS = 60;
/** Past the exports' worst case, so a flush settles on what the platform answered rather than time out first. */
const FLUSH_SLACK_SECONDS = 30;

/**
 * How the SDK's warnings of an answer that took the export begin: the
 * platform kept the turn but for what it names, and would answer a copy the
 * same way, so sending it again would only hold up the turns after it.
 */
const TAKEN_IN_PART = 'telmoni: the server ';

/** How long a turn's flush is waited for: each of its batches at the SDK's worst case, one after another, and the slack. */
function flushSeconds(record: RunRecord): number {
  // The run's own two spans, then one per item and one per call inside a step, as the SDK counts them.
  const spans = (record.inside ?? []).reduce(
    (count, item) => count + 1 + (item.type === 'step' ? (item.calls?.length ?? 0) : 0),
    2,
  );
  const batchSeconds = ATTEMPTS * ATTEMPT_SECONDS + (ATTEMPTS - 1) * RETRY_WAIT_SECONDS;
  return FLUSH_SLACK_SECONDS + Math.ceil(spans / BATCH_SPANS) * batchSeconds;
}

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

export class Sender {
  readonly #telmoni: Telmoni;
  readonly #warnings: string[] = [];
  readonly #log: (line: string) => void;

  /** `hooks` is the tests' way to shorten the SDK's waits between attempts. */
  constructor(destination: Destination, log: (line: string) => void, hooks: Pick<Hooks, 'sleep'> = {}) {
    this.#log = log;
    this.#telmoni = new Telmoni(
      { endpoint: destination.endpoint, apiKey: destination.apiKey },
      {
        ...hooks,
        warn: (message) => void this.#warnings.push(message),
        // One turn is queued at a time, whole, and flushed before the next:
        // past the SDK's default bound a long turn's last spans would be
        // dropped, on every hook, and the turn never count as sent.
        processor: { maxQueueSize: Number.POSITIVE_INFINITY },
      },
    );
  }

  /**
   * Whether the platform took the turn. The SDK warns of every export it
   * could not deliver and every span refused, and its warnings never carry a
   * session's content, so a turn counts as taken when its flush settles with
   * no warning but of what the platform kept it without. A record the SDK
   * refuses counts as done: it would be refused again on every hook, and
   * must not hold up the turns after it.
   */
  async send(record: RunRecord): Promise<boolean> {
    try {
      this.#telmoni.recordRun(record);
    } catch (error) {
      this.#log(`turn refused by the SDK: ${error instanceof Error ? error.name : typeof error}`);
      return true;
    }
    const flushed = await this.#telmoni.flush(flushSeconds(record));
    const warnings = this.#warnings.splice(0);
    const failures = warnings.filter((warning) => !warning.startsWith(TAKEN_IN_PART));
    if (flushed && failures.length === 0) {
      if (warnings.length > 0) this.#log(`taken in part: ${warnings.join('; ')}`);
      return true;
    }
    this.#log(flushed ? `not sent: ${failures.join('; ')}` : 'not sent: the export did not finish in time');
    return false;
  }

  close(): Promise<void> {
    return this.#telmoni.shutdown();
  }
}
