/**
 * Sends a session's finished turns through the TypeScript SDK, one export each: a turn sent again, after a hook
 * that died before saving that it had, is the same bytes, which ingest stores once within the hour.
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
 * The SDK's warnings of spans it could not deliver, which a later hook may yet get through: Telmoni out of reach or busy
 * past its retries, or a key or an endpoint it refused. Every other warning is of spans delivered, or dropped for good.
 */
const UNDELIVERED = /^telmoni: (?:export failed after |an export failed \(|the export queue was full|export refused with (?!400 |402 |413 |500 ))/;
/** Ingest's `500` for a fault of its database, which a later hook may find mended, as it would none of its other `500`s. */
const DATABASE_FAILED = /^telmoni: export refused with 500 \/errors\/internal\/database;/;
/** An export refused for good: for what it holds (`400`, `413`), a fault of ingest's own (any other `500`), an organization paused (`402`). */
const REFUSED = /^telmoni: export refused with (?:400|402|413|500) /;

/** How long a turn's flush is waited for: each of its batches at the SDK's worst case, one after another, and the slack. */
export function flushSecondsOf(record: RunRecord): number {
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

interface Client {
  telmoni: Telmoni;
  warnings: string[];
}

export class Sender {
  readonly #destination: Destination;
  readonly #log: (line: string) => void;
  readonly #hooks: Pick<Hooks, 'sleep'>;
  /** The first turn's client, made with the sender so the SDK refuses an endpoint before any turn is read. */
  #first: Client | undefined;

  /** `hooks` is the tests' way to shorten the SDK's waits between attempts. */
  constructor(destination: Destination, log: (line: string) => void, hooks: Pick<Hooks, 'sleep'> = {}) {
    this.#destination = destination;
    this.#log = log;
    this.#hooks = hooks;
    this.#first = this.#client();
  }

  #client(): Client {
    const warnings: string[] = [];
    const telmoni = new Telmoni(
      { endpoint: this.#destination.endpoint, apiKey: this.#destination.apiKey },
      {
        ...this.#hooks,
        warn: (message) => void warnings.push(message),
        // Unbounded: past the SDK's default 2,048 spans `recordRun` throws `QueueFullError`, and the turn would be passed over whole.
        processor: { maxQueueSize: Number.POSITIVE_INFINITY },
      },
    );
    return { telmoni, warnings };
  }

  /**
   * Whether the turn is done with: taken, whole or in part, or refused for good, which the same bytes would get on every
   * hook. The SDK's warnings, logged as they are, never carry anything of the session.
   */
  async send(record: RunRecord): Promise<boolean> {
    // A client of its own: the SDK warns of each kind once a client, and a turn refused as one before it, unwarned, would read as taken.
    const { telmoni, warnings } = this.#first ?? this.#client();
    this.#first = undefined;
    try {
      try {
        telmoni.recordRun(record);
      } catch (error) {
        this.#log(`turn refused by the SDK: ${error instanceof Error ? error.name : typeof error}`);
        return true;
      }
      const flushed = await telmoni.flush(flushSecondsOf(record));
      const failures = warnings.filter((warning) => UNDELIVERED.test(warning) || DATABASE_FAILED.test(warning));
      if (flushed && failures.length === 0) {
        if (warnings.some((warning) => REFUSED.test(warning))) this.#log(`refused, not sent again: ${warnings.join('; ')}`);
        else if (warnings.length > 0) this.#log(`taken in part: ${warnings.join('; ')}`);
        return true;
      }
      this.#log(flushed ? `not sent: ${failures.join('; ')}` : 'not sent: the export did not finish in time');
      return false;
    } finally {
      await telmoni.shutdown();
    }
  }

  async close(): Promise<void> {
    await this.#first?.telmoni.shutdown();
  }
}
