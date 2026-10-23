import { describe, expect, it } from 'vitest';

import { settingsFrom } from '../src/settings';

describe('the settings', () => {
  it('name Bedrock or Vertex as the provider where Claude Code runs on them, and Anthropic otherwise', () => {
    expect(settingsFrom({ CLAUDE_CONFIG_DIR: '/c' }).provider).toBe('anthropic');
    expect(settingsFrom({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1' }).provider).toBe('aws.bedrock');
    expect(settingsFrom({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_VERTEX: 'true' }).provider).toBe('gcp.vertex_ai');
    for (const off of ['', '0', 'false', 'No', ' off ']) {
      expect(settingsFrom({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: off, CLAUDE_CODE_USE_VERTEX: off }).provider).toBe('anthropic');
    }
  });

  it('take the plugin’s own option over the SDKs’ variable', () => {
    const settings = settingsFrom({
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: 'telmoni_option',
      TELMONI_API_KEY: 'telmoni_variable',
      CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: 'https://option.example.com',
      TELMONI_ENDPOINT: 'https://variable.example.com',
    });
    expect([settings.apiKey, settings.endpoint]).toEqual(['telmoni_option', 'https://option.example.com']);
  });

  it('pass over an option left blank to the variable, and leave unset what neither sets', () => {
    const settings = settingsFrom({
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY: ' ',
      TELMONI_API_KEY: 'telmoni_variable',
      CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT: '',
    });
    expect([settings.apiKey, settings.endpoint]).toEqual(['telmoni_variable', undefined]);
  });
});
