/**
 * Where the plugin sends, and where it keeps its state: the plugin's own
 * configuration first — `/plugin configure`, which Claude Code hands a hook as
 * `CLAUDE_PLUGIN_OPTION_<NAME>`, the key from the system's keychain — then the
 * SDKs' own variables.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Settings {
  apiKey: string | undefined;
  /** Unset, the SDK's own default, Telmoni's machine host. */
  endpoint: string | undefined;
  /** The plugin's folder: each session's state, the locks and `hook.log`. */
  dir: string;
  /** The GenAI conventions' name for whoever serves Claude Code its model. */
  provider: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const key of [`CLAUDE_PLUGIN_OPTION_${name}`, name]) {
    const found = env[key]?.trim();
    if (found) return found;
  }
  return undefined;
}

function isOn(flag: string | undefined): boolean {
  return flag !== undefined && !['', '0', 'false', 'no', 'off'].includes(flag.trim().toLowerCase());
}

export function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  // Beside the session transcripts of whichever configuration folder Claude
  // Code runs with, so two installations keep two states.
  const claude = env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude');
  let provider = 'anthropic';
  if (isOn(env['CLAUDE_CODE_USE_BEDROCK'])) provider = 'aws.bedrock';
  else if (isOn(env['CLAUDE_CODE_USE_VERTEX'])) provider = 'gcp.vertex_ai';
  return {
    apiKey: value(env, 'TELMONI_API_KEY'),
    endpoint: value(env, 'TELMONI_ENDPOINT'),
    dir: join(claude, 'telmoni'),
    provider,
  };
}
