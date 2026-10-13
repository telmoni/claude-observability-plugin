/**
 * A segment of a transcript as a run record: the turn a run of `claude-code`,
 * the session its session, each reply of the model a model call, each tool a
 * tool call, each subagent a step with its own calls inside it, and the
 * skills the turn ran its tag `skills`.
 */

import { createHash } from 'node:crypto';

import type { CallRecord, ModelCallRecord, RunRecord, StepRecord, ToolCallRecord } from 'telmoni';

import {
  type Entry,
  type Segment,
  type Usage,
  blocksOf,
  endsTurn,
  isInterruption,
  isToolResult,
} from './transcript.js';

export const AGENT = 'claude-code';

/** The plugin's own namespace for run ids, so no other tool's ids can meet them. */
const NAMESPACE = '843bf4bd-49bf-4cf9-8305-6eeaa16cafb3';

/** The tools whose work is a subagent's, read from its own transcript. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** Subagents nest; past this depth one's transcript is not opened. */
const MAX_DEPTH = 4;

/**
 * A tool's or a skill's name as Claude Code spells one, within the length
 * the platform keeps of a name: anything else — a skill's name is the
 * model's own writing — is no name, and is never sent.
 */
const NAME = /^[\w.:-]{1,128}$/;

/** A model's id as providers spell one, within the length the platform keeps. */
const MODEL = /^[\w.:@/[\]-]{1,128}$/;

/** The most the platform keeps of a tag's value: past it, the tag would be dropped whole. */
const TAG_MAX = 256;

/** A version 5 UUID (RFC 9562): the same turn always gets the same run id. */
export function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A subagent's transcript, found by the tool call that started it. */
export interface Subagent {
  /** The subagent's kind, as Claude Code names it: `Explore`, `general-purpose`, or one of the person's own. */
  type: string | undefined;
  /** Its work up to the end of its first run: a later turn may resume it, and that is no part of this step. */
  entries: Entry[];
  /** Whether its transcript shows that run ended; a subagent run in the background may still be at work. */
  ended: boolean;
  /** When its transcript was last written, in milliseconds since the epoch. */
  touched: number;
}

export interface Context {
  sessionId: string;
  /** The GenAI conventions' name for whoever served the model. */
  provider: string;
  subagent: (toolUseId: string) => Subagent | undefined;
  /** Whether the session's end, rather than the segment's own last reply, closed it. */
  sessionEnded: boolean;
}

function timeOf(entry: Entry): number | undefined {
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** Claude Code's own error kinds are words like `rate_limit`; anything else is named generically. */
function errorTypeOf(entry: Entry): string {
  return typeof entry.error === 'string' && /^[a-z][a-z_]{0,63}$/.test(entry.error) ? entry.error : 'api_error';
}

/** An error Claude Code wrote in the model's place: no call the model answered. */
function isSynthetic(entry: Entry): boolean {
  return entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>';
}

/**
 * Claude Code counts input apart from the cache's reads and writes; the SDK
 * takes input as the conventions count it, the cache's tokens included.
 */
function usageOf(usage: Usage | undefined): ModelCallRecord['usage'] {
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined;
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  return {
    inputTokens: count(usage.input_tokens) + read + write,
    outputTokens: count(usage.output_tokens),
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
  };
}

interface Found {
  items: Array<CallRecord | StepRecord>;
  skills: Set<string>;
  /** The latest time any of the work ended. */
  last: number | undefined;
}

/**
 * The model and tool calls among `entries`, each reply once however many
 * lines Claude Code wrote it in. A subagent's tool call, its transcript found,
 * is a step of the subagent's own calls at the top (`depth` 0), and below it
 * the subagent's calls beside the tool call that started it. None starts
 * before `floor`, the start of the run or the step it is part of.
 */
function callsIn(
  entries: readonly Entry[],
  context: Context,
  depth: number,
  until: number | undefined,
  floor: number,
): Found {
  const found: Found = { items: [], skills: new Set(), last: undefined };
  const seen = (time: number | undefined): void => {
    if (time !== undefined && (found.last === undefined || time > found.last)) found.last = time;
  };
  const results = new Map<string, Entry>();
  for (const entry of entries) {
    if (!isToolResult(entry)) continue;
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') results.set(block.tool_use_id, entry);
    }
  }
  let previous: number | undefined;
  let reply: { id: string | undefined; call: ModelCallRecord } | undefined;
  for (const entry of entries) {
    // A subagent's own transcript is sidechain throughout; in the session's,
    // a sidechain line is an older Claude Code's subagent, written inline.
    if (depth === 0 && entry.isSidechain) continue;
    const time = timeOf(entry);
    if (entry.type === 'assistant' && !isSynthetic(entry) && time !== undefined) {
      const message = entry.message ?? {};
      const id = typeof message.id === 'string' ? message.id : undefined;
      if (reply !== undefined && id !== undefined && id === reply.id) {
        reply.call.end = Math.max(Number(reply.call.end), time);
        // Each line of a reply repeats its usage, and in a subagent's
        // transcript the earlier lines hold the counts so far: the last is whole.
        const usage = usageOf(message.usage);
        if (usage !== undefined) reply.call.usage = usage;
      } else if (typeof message.model === 'string' && message.model !== '') {
        // The request went out as the entry before the reply's first line was
        // written: the prompt, or the last tool's result.
        const call: ModelCallRecord = {
          type: 'model_call',
          model: MODEL.test(message.model) ? message.model : 'unknown',
          provider: context.provider,
          start: Math.min(previous ?? time, time),
          end: time,
        };
        const usage = usageOf(message.usage);
        if (usage !== undefined) call.usage = usage;
        found.items.push(call);
        reply = { id, call };
      }
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || typeof block.name !== 'string' || typeof block.id !== 'string') continue;
        if (block.name === 'Skill') {
          const skill = (block.input as { skill?: unknown } | null | undefined)?.skill;
          if (typeof skill === 'string' && NAME.test(skill.trim())) found.skills.add(skill.trim());
        }
        const result = results.get(block.id);
        const answered = result === undefined ? undefined : timeOf(result);
        const failed =
          result !== undefined && blocksOf(result).some((b) => b.tool_use_id === block.id && b.is_error === true);
        const subagent =
          depth < MAX_DEPTH && SUBAGENT_TOOLS.has(block.name) ? context.subagent(block.id) : undefined;
        const inner =
          subagent === undefined ? undefined : callsIn(subagent.entries, context, depth + 1, until, Math.max(floor, time));
        for (const skill of inner?.skills ?? []) found.skills.add(skill);
        if (subagent !== undefined && inner !== undefined && depth === 0) {
          // A subagent run in the background answers its tool call at once
          // and works on: the step ends with the last of its own work.
          const step: StepRecord = {
            type: 'step',
            name: `subagent ${subagent.type ?? 'unknown'}`,
            start: time,
            end: Math.max(time, answered ?? time, inner.last ?? time),
            calls: inner.items.filter((item): item is CallRecord => item.type !== 'step'),
          };
          if (failed) step.errorType = 'ToolError';
          else if (answered === undefined || !subagent.ended) step.cancelled = true;
          found.items.push(step);
          seen(Number(step.end));
          continue;
        }
        const name = NAME.test(block.name) ? block.name : 'unknown';
        const tool: ToolCallRecord = { type: 'tool_call', name, start: time, end: time };
        if (answered !== undefined) {
          tool.end = Math.max(answered, time);
          if (failed) tool.errorType = 'ToolError';
        } else {
          // Never answered: the turn was interrupted, or the session ended, first.
          tool.end = Math.max(until ?? time, time);
          tool.cancelled = true;
        }
        found.items.push(tool);
        seen(Number(tool.end));
        if (inner !== undefined) {
          for (const item of inner.items) found.items.push(item);
          seen(inner.last);
        }
      }
    }
    if (time !== undefined) {
      if (entry.type === 'assistant' || isToolResult(entry) || isInterruption(entry)) seen(time);
      previous = time;
    }
  }
  // Claude Code writes a prompt's attachments a few milliseconds before the
  // prompt, and a clock may step back: nothing starts before what holds it,
  // and nothing ends before it starts, which the SDK would refuse whole.
  for (const item of found.items) {
    item.start = Math.max(floor, Number(item.start));
    item.end = Math.max(Number(item.start), Number(item.end));
  }
  // In the order they started, so the record, and the ids derived from each
  // span's place in it, come out the same however the lines were written.
  const order = new Map(found.items.map((item, index) => [item, index]));
  found.items.sort((a, b) => Number(a.start) - Number(b.start) || order.get(a)! - order.get(b)!);
  return found;
}

/** The subagents a segment's tool calls started, and theirs in turn, as deep as a record holds them. */
export function subagentsIn(segment: Segment, context: Context): Subagent[] {
  const found: Subagent[] = [];
  const walk = (entries: readonly Entry[], depth: number): void => {
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.type !== 'assistant' || (depth === 0 && entry.isSidechain)) continue;
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || !SUBAGENT_TOOLS.has(block.name ?? '')) continue;
        const subagent = context.subagent(block.id);
        if (subagent === undefined) continue;
        found.push(subagent);
        walk(subagent.entries, depth + 1);
      }
    }
  };
  walk(segment.entries, 0);
  return found;
}

/** Names joined into a tag, as many whole as the platform keeps of one. */
function tagOf(names: readonly string[]): string {
  let tag = '';
  for (const name of names) {
    const longer = tag === '' ? name : `${tag},${name}`;
    if (longer.length > TAG_MAX) break;
    tag = longer;
  }
  return tag;
}

/** The segment as a run, or nothing where it holds no time to place it at. */
export function recordOf(segment: Segment, context: Context): RunRecord | undefined {
  const main = segment.entries.filter((entry) => !entry.isSidechain);
  const first = main.find((entry) => typeof entry.uuid === 'string' && timeOf(entry) !== undefined);
  if (first === undefined) return undefined;
  const start = timeOf(first)!;
  let lastTime: number | undefined;
  for (const entry of main) {
    const time = timeOf(entry);
    if (time !== undefined && (entry.type === 'assistant' || isToolResult(entry) || isInterruption(entry))) {
      lastTime = Math.max(lastTime ?? time, time);
    }
  }
  const found = callsIn(main, context, 0, lastTime, start);
  const record: RunRecord = {
    runId: uuid5(NAMESPACE, `${context.sessionId}/${first.uuid}`),
    agent: AGENT,
    sessionId: context.sessionId,
    start,
    end: Math.max(start, lastTime ?? start, found.last ?? start),
    inside: found.items,
  };
  if (found.skills.size > 0) record.tags = { skills: tagOf([...found.skills].sort()) };
  const replies = main.filter((entry) => entry.type === 'assistant');
  const lastReply = replies.at(-1);
  const after = lastReply === undefined ? main : main.slice(main.lastIndexOf(lastReply) + 1);
  if (lastReply !== undefined && isSynthetic(lastReply)) {
    record.errorType = errorTypeOf(lastReply);
  } else if (after.some(isInterruption)) {
    record.cancelled = true;
  } else if (context.sessionEnded && (lastReply === undefined || !endsTurn(lastReply))) {
    record.cancelled = true;
  }
  return record;
}
