import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { log } from '../src/log';
import { tempDir } from './helpers';

let root: { path: string; remove: () => void };

beforeEach(() => {
  root = tempDir();
});

afterEach(() => {
  root.remove();
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('the hook’s log', () => {
  it.skipIf(process.platform === 'win32')('is hook.log, readable by its owner alone, in a folder only its owner can open', () => {
    const dir = join(root.path, 'telmoni');
    log(dir, 'Stop 0b1c2d3e: no key');
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, 'hook.log'))).toBe(0o600);
    expect(readFileSync(join(dir, 'hook.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z Stop 0b1c2d3e: no key\n$/);
  });

  it.skipIf(process.platform === 'win32')('is moved aside past a megabyte, and begun again as shut as before', () => {
    const dir = join(root.path, 'telmoni');
    log(dir, 'first');
    writeFileSync(join(dir, 'hook.log'), 'x'.repeat(1024 * 1024), { flag: 'a' });
    log(dir, 'second');
    expect(readFileSync(join(dir, 'hook.log.1'), 'utf8')).toMatch(/^\S+ first\nx+$/);
    expect(readFileSync(join(dir, 'hook.log'), 'utf8')).toMatch(/^\S+ second\n$/);
    expect(modeOf(join(dir, 'hook.log'))).toBe(0o600);
    expect(modeOf(join(dir, 'hook.log.1'))).toBe(0o600);
  });
});
