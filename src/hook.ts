/**
 * The hook Claude Code runs at `Stop`, `StopFailure` and `SessionEnd`.
 *
 * It reads what Claude Code hands it, starts a detached copy of itself with
 * that, and exits at once: the session never waits on the network, and a
 * Telmoni that does not answer never slows it. The copy waits for the turn's
 * last lines to be written, then sends what has ended (`session.ts`).
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { inputFrom, isCursor } from './input.js';
import { kindOf, log } from './log.js';
import { Sender } from './send.js';
import { sync } from './session.js';
import { settingsFrom } from './settings.js';

/** How the detached copy is handed its input: in its environment, never on its command line, which anyone on the machine may list. */
const HANDOFF = 'TELMONI_CLAUDE_HOOK_INPUT';
const MAX_INPUT_BYTES = 1024 * 1024;
const INPUT_WAIT_MS = 5_000;
/** Claude Code writes a turn's last lines as its hooks start. */
const SETTLE_MS = 1_500;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      reject(new Error('no hook input'));
      // Let go of it, or the process lives on for as long as it stays open.
      process.stdin.destroy();
    }, INPUT_WAIT_MS);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        clearTimeout(timer);
        reject(new RangeError('hook input too large'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const settings = settingsFrom(process.env);
const handedOff = process.env[HANDOFF];

try {
  if (handedOff === undefined) {
    const raw = JSON.parse(await readStdin()) as unknown;
    const input = inputFrom(raw);
    if (isCursor(raw, process.env)) {
      // Cursor's own session, which Telmoni's Cursor plugin records.
    } else if (input === undefined) {
      log(settings.dir, 'hook input not understood; nothing sent');
    } else {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, [HANDOFF]: JSON.stringify(input) },
      });
      child.on('error', (error) => log(settings.dir, `${input.event}: could not start the sender: ${kindOf(error)}`));
      child.unref();
    }
  } else {
    const input = inputFrom(JSON.parse(handedOff));
    if (input !== undefined) {
      const tag = `${input.event} ${input.sessionId.slice(0, 8)}:`;
      const write = (line: string): void => log(settings.dir, `${tag} ${line}`);
      await sleep(SETTLE_MS);
      await sync(input, settings, { sender: (destination) => new Sender(destination, write), log: write });
    }
  }
} catch (error) {
  log(settings.dir, `failed: ${kindOf(error)}`);
}
// Nothing the session could see: whatever happened is in hook.log.
process.exitCode = 0;
