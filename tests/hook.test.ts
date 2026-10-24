/**
 * The built hook, run as Claude Code runs it: a process handed its input on
 * stdin, which must exit at once while a detached copy sends.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeIngest, fixture, tempDir } from './helpers';

const HOOK = fileURLToPath(new URL('../dist/hook.mjs', import.meta.url));
const SESSION = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const KEY = 'telmoni_test';

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

function runHook(input: object, env: Record<string, string>): Promise<{ code: number | null; ms: number; stdout: string; stderr: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only what Claude Code hands a hook, and a home of the test's own.
      env: { PATH: process.env['PATH'] ?? '', HOME: home.path, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ms: Date.now() - started, stdout, stderr }));
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

/** Whether the copy is done with the session: its place saved at the transcript's end, and its lock let go. */
function settled(claude: string, transcript: string): boolean {
  const state = join(claude, 'telmoni', `${SESSION}.json`);
  if (!existsSync(state) || existsSync(join(claude, 'telmoni', `${SESSION}.lock`))) return false;
  return (JSON.parse(readFileSync(state, 'utf8')) as { offset: number }).offset === statSync(transcript).size;
}

describe('the hook', () => {
  it('exits at once, and its detached copy sends every ended turn and saves where it stopped', async () => {
    expect(existsSync(HOOK), 'build the hook first: npm run build').toBe(true);
    const claude = join(home.path, '.claude');
    const transcript = join(claude, 'projects', 'p', `${SESSION}.jsonl`);
    cpSync(fixture('subagent'), transcript, { recursive: true });
    cpSync(join(dirname(fixture('subagent')), 'session'), join(dirname(transcript), SESSION), { recursive: true });
    const { code, ms, stdout, stderr } = await runHook(
      {
        session_id: SESSION,
        transcript_path: transcript,
        cwd: home.path,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      },
      {
        CLAUDE_CONFIG_DIR: claude,
        CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: KEY,
        CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: endpoint,
      },
    );
    const state = join(claude, 'telmoni', `${SESSION}.json`);
    // Gone before its copy sent a thing: the session never waits on the network.
    expect(ingest.received).toEqual([]);
    expect(existsSync(state)).toBe(false);
    expect(code).toBe(0);
    expect([stdout, stderr]).toEqual(['', '']);
    expect(ms).toBeLessThan(1500);
    expect(await until(() => settled(claude, transcript), 20_000)).toBe(true);
    expect(ingest.received).toHaveLength(3);
    const bodies = ingest.received.map((request) => request.body).join('');
    expect(bodies).not.toContain('…');
    expect(bodies).not.toContain(home.path);
    expect(bodies).not.toContain(KEY);
    expect(ingest.spans().filter((span) => span.name === 'invoke_agent claude-code')).toHaveLength(3);
    expect(existsSync(join(claude, 'telmoni', 'hook.log'))).toBe(false);
    // What it keeps: places, ids and times, shut to everyone but its owner.
    const kept = join(claude, 'telmoni');
    if (process.platform !== 'win32') expect(statSync(kept).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(kept)) {
      if (process.platform !== 'win32') expect(statSync(join(kept, name)).mode & 0o777).toBe(0o600);
      const text = readFileSync(join(kept, name), 'utf8');
      for (const secret of [KEY, home.path, 'projects', '…']) expect(text).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(readFileSync(state, 'utf8')) as object).sort()).toEqual(['mark', 'marked', 'offset', 'sent', 'through']);
  }, 30_000);

  it('hands its copy the session in its environment, never on a command line anyone may list', async () => {
    const claude = join(home.path, '.claude');
    const transcript = join(claude, 'projects', 'p', `${SESSION}.jsonl`);
    cpSync(fixture('interrupted'), transcript, { recursive: true });
    const { code, stdout, stderr } = await runHook(
      { session_id: SESSION, transcript_path: transcript, hook_event_name: 'SessionEnd', reason: 'other' },
      { CLAUDE_CONFIG_DIR: claude, CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: KEY, CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: endpoint },
    );
    expect(code).toBe(0);
    expect([stdout, stderr]).toEqual(['', '']);
    if (process.platform === 'linux') {
      // Found, in the moment before it reads, by the home this test gave it, which only its environment shows.
      const copies = readdirSync('/proc').flatMap((pid) => {
        try {
          const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
          return argv.includes(HOOK) && env.includes(`HOME=${home.path}`) ? [argv] : [];
        } catch {
          return [];
        }
      });
      expect(copies).toHaveLength(1);
      for (const secret of [KEY, SESSION, transcript]) expect(copies[0]).not.toContain(secret);
    }
    // Over only once the copy is: one left running would write into the home this test removes.
    expect(await until(() => settled(claude, transcript), 20_000)).toBe(true);
    expect(ingest.received.length).toBeGreaterThan(0);
  }, 30_000);

  it('logs a state it cannot read under its session, and leaves the state and the turns alone', async () => {
    const claude = join(home.path, '.claude');
    const transcript = join(claude, 'projects', 'p', `${SESSION}.jsonl`);
    cpSync(fixture('interrupted'), transcript, { recursive: true });
    const kept = join(claude, 'telmoni');
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    // Torn as no hook leaves one, since each syncs its state before renaming it over the last.
    writeFileSync(join(kept, `${SESSION}.json`), '{"offset":', { mode: 0o600 });
    const { code } = await runHook(
      { session_id: SESSION, transcript_path: transcript, hook_event_name: 'Stop' },
      { CLAUDE_CONFIG_DIR: claude, CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: KEY, CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: endpoint },
    );
    expect(code).toBe(0);
    const logged = join(kept, 'hook.log');
    // The line is the copy's last write.
    expect(await until(() => existsSync(logged) && readFileSync(logged, 'utf8').endsWith('\n'), 20_000)).toBe(true);
    expect(readFileSync(logged, 'utf8')).toMatch(/^\S+ Stop 0b1c2d3e: failed: SyntaxError\n$/);
    expect(readFileSync(join(kept, `${SESSION}.json`), 'utf8')).toBe('{"offset":');
    expect(ingest.received).toEqual([]);
  }, 30_000);

  it('exits, saying why, when Claude Code never closes its input', async () => {
    const claude = join(home.path, '.claude');
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { PATH: process.env['PATH'] ?? '', HOME: home.path, CLAUDE_CONFIG_DIR: claude },
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(-1);
      }, 9_000);
      child.on('exit', (exited) => {
        clearTimeout(timer);
        resolve(exited);
      });
    });
    expect(code).toBe(0);
    expect(readFileSync(join(claude, 'telmoni', 'hook.log'), 'utf8')).toMatch(/failed: NoHookInput\n$/);
  }, 15_000);

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
    const { code, stdout, stderr } = await runHook({ hook_event_name: 'Stop', session_id: '../../etc' }, { CLAUDE_CONFIG_DIR: claude });
    expect(code).toBe(0);
    expect([stdout, stderr]).toEqual(['', '']);
    expect(readFileSync(join(claude, 'telmoni', 'hook.log'), 'utf8')).toMatch(/hook input not understood/);
    expect(ingest.received).toEqual([]);
  });
});
