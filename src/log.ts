/**
 * The hook's log, `hook.log` in the plugin's folder: a line per thing that
 * went wrong, naming its kind and never anything from the session — no text,
 * no path, no key — since the hook runs where nobody sees its output.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Past this, the log is moved aside to `hook.log.1` and begun again. */
const MAX_BYTES = 1024 * 1024;

export function log(dir: string, line: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'hook.log');
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to say so; the session must never see the hook fail.
  }
}

/** An error's class, which is all of it the log keeps. */
export function kindOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name}:${code}` : error.name;
  }
  return typeof error;
}
