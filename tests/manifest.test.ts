/**
 * The package as Claude Code installs it: the marketplace naming the npm
 * package, the plugin's manifest and hooks, and what npm would publish.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${ROOT}${path}`, 'utf8')) as Record<string, unknown>;
}

describe('the package', () => {
  it('is the one plugin its marketplace names, by the npm package, at the package’s own version', () => {
    const pkg = json('package.json');
    const plugin = json('.claude-plugin/plugin.json');
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(pkg['name']).toBe('telmoni-claude-observability-plugin');
    expect(plugin['name']).toBe('telmoni-observability');
    expect(plugin['version']).toBe(pkg['version']);
    expect(marketplace['name']).toBe('telmoni-plugins');
    expect(marketplace['plugins']).toEqual([
      expect.objectContaining({ name: 'telmoni-observability', source: { source: 'npm', package: pkg['name'] } }),
    ]);
  });

  it('asks for the key as a secret, and gives no option a default to stand ahead of the SDKs’ variables', () => {
    const options = json('.claude-plugin/plugin.json')['userConfig'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(options).sort()).toEqual(['TELMONI_API_KEY', 'TELMONI_ENDPOINT']);
    expect(options['TELMONI_API_KEY']!['sensitive']).toBe(true);
    for (const option of Object.values(options)) expect(option).not.toHaveProperty('default');
  });

  it('runs the built hook on node, with no shell, at a turn’s stop, its failure and the session’s end', () => {
    const hooks = json('hooks/hooks.json')['hooks'] as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['SessionEnd', 'Stop', 'StopFailure']);
    for (const groups of Object.values(hooks)) {
      expect(groups).toEqual([
        { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs'], timeout: 10 }] },
      ]);
    }
  });

  it('packs the built hook and its manifests, and nothing else', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out) as unknown;
    const pack = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]) as { files: Array<{ path: string }> };
    expect(pack.files.map((file) => file.path).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'LICENSE',
      'README.md',
      'dist/hook.mjs',
      'hooks/hooks.json',
      'package.json',
    ]);
  });
});
