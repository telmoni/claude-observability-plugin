/**
 * The built hook, run as Claude Code runs it: a process handed its input on
 * stdin, which must exit at once while a detached copy sends.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeIngest, fixture, tempDir } from './helpers';

const HOOK = fileURLToPath(new URL('../dist/hook.mjs', import.meta.url));
const SESSION = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

let home: { path: string; remove: () => void };
let ingest: FakeIngest;
let endpoint: string;

beforeEach(async () => {
  home = tempDir();
  ingest = new FakeIngest();
  endpoint = await ingest.start();
});

afterEach(async () => {
  await ingest.stop();
  home.remove();
});

function runHook(input: object, env: Record<string, string>): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'ignore', 'ignore'],
      // Only what Claude Code hands a hook, and a home of the test's own.
      env: { PATH: process.env['PATH'] ?? '', HOME: home.path, ...env },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe('the hook', () => {
  it('exits at once, and its detached copy sends every ended turn and saves where it stopped', async () => {
    expect(existsSync(HOOK), 'build the hook first: npm run build').toBe(true);
    const claude = join(home.path, '.claude');
    const transcript = join(claude, 'projects', 'p', `${SESSION}.jsonl`);
    cpSync(fixture('subagent'), transcript, { recursive: true });
    cpSync(join(dirname(fixture('subagent')), 'session'), join(dirname(transcript), SESSION), { recursive: true });
    const { code, ms } = await runHook(
      {
        session_id: SESSION,
        transcript_path: transcript,
        cwd: home.path,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      {
        CLAUDE_CONFIG_DIR: claude,
        CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: 'telmoni_test',
        CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: endpoint,
      },
    );
    expect(code).toBe(0);
    expect(ms).toBeLessThan(1500);
    const state = join(claude, 'telmoni', `${SESSION}.json`);
    const size = statSync(transcript).size;
    expect(
      await until(() => existsSync(state) && (JSON.parse(readFileSync(state, 'utf8')) as { offset: number }).offset === size, 20_000),
    ).toBe(true);
    expect(ingest.received).toHaveLength(3);
    const bodies = ingest.received.map((request) => request.body).join('');
    expect(bodies).not.toContain('…');
    expect(bodies).not.toContain(home.path);
    expect(ingest.spans().filter((span) => span.name === 'invoke_agent claude-code')).toHaveLength(3);
    expect(existsSync(join(claude, 'telmoni', 'hook.log'))).toBe(false);
  }, 30_000);

  it('leaves Cursor’s sessions alone when Cursor runs it, logging nothing', async () => {
    const claude = join(home.path, '.claude');
    const { code } = await runHook(
      { hook_event_name: 'stop', conversation_id: 'c', cursor_version: '2026.08.11-e8db854', status: 'completed' },
      { CLAUDE_CONFIG_DIR: claude },
    );
    expect(code).toBe(0);
    expect(existsSync(join(claude, 'telmoni'))).toBe(false);
  });

  it('logs input it does not understand, sends nothing, and still exits 0', async () => {
    const claude = join(home.path, '.claude');
    const { code } = await runHook({ hook_event_name: 'Stop', session_id: '../../etc' }, { CLAUDE_CONFIG_DIR: claude });
    expect(code).toBe(0);
    expect(readFileSync(join(claude, 'telmoni', 'hook.log'), 'utf8')).toMatch(/hook input not understood/);
    expect(ingest.received).toEqual([]);
  });
});
