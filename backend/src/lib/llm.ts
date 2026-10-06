import {
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from './aws.js';
import { getConfig, type ModelEffort } from './config.js';
import { errFields, log } from './log.js';
import type { Usage } from './types.js';

export type LlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'end'; usage: Usage; stopReason?: string };

const isAnthropic = (modelId: string) => modelId.toLowerCase().includes('anthropic');
const isNova = (modelId: string) => modelId.toLowerCase().includes('nova');

type AdditionalFields = ConverseStreamCommandInput['additionalModelRequestFields'];

/**
 * Model-specific request fields (ADR-004).
 *
 * VERIFY AGAINST BEDROCK DOCS: for Claude we request effort (default `low`, env MODEL_EFFORT)
 * using the Anthropic Messages API shape `output_config: { effort }` (GA on the Claude API,
 * no beta header) passed through Converse `additionalModelRequestFields`. Whether Bedrock
 * forwards this exact shape for the configured inference profile has NOT been verified against
 * a live endpoint. Safety net: if Bedrock answers ValidationException, the call is retried once
 * without these fields and they are disabled for the rest of the container (see below).
 * MODEL_EFFORT=off disables sending them at all. Non-Anthropic models get no extra fields.
 */
export function modelSpecificRequestFields(modelId: string, effort: ModelEffort = 'low'): AdditionalFields {
  if (effort === 'off') return undefined;
  if (isAnthropic(modelId)) {
    return { output_config: { effort } };
  }
  return undefined;
}

// ---- per-container memory: model-specific fields rejected by Bedrock ----

let fieldsRejected = false;

/** Fields to send for this call, honouring MODEL_EFFORT and a previous rejection. */
function requestFieldsFor(modelId: string): AdditionalFields {
  if (fieldsRejected) return undefined;
  return modelSpecificRequestFields(modelId, getConfig().modelEffort);
}

function isValidationError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ValidationException';
}

function markFieldsRejected(modelId: string, err: unknown): void {
  if (fieldsRejected) return;
  fieldsRejected = true;
  // One warning per container. No prompt content — only ids and the error name.
  log.warn('model_specific_fields_rejected', { modelId, errName: errFields(err).errName });
}

/** Test helper. */
export function resetModelFieldsStateForTests(): void {
  fieldsRejected = false;
}

/**
 * System blocks: the byte-stable system prompt, followed by a cache point for models that
 * support Converse prompt caching (Claude / Nova). Prefixes below the model's minimum
 * cacheable size are simply not cached.
 */
export function systemBlocks(modelId: string, systemPrompt: string): SystemContentBlock[] {
  const blocks: SystemContentBlock[] = [{ text: systemPrompt }];
  if (isAnthropic(modelId) || isNova(modelId)) blocks.push({ cachePoint: { type: 'default' } });
  return blocks;
}

export interface StreamParams {
  modelId: string;
  systemPrompt: string;
  messages: Message[];
  maxTokens: number;
  abortSignal?: AbortSignal;
}

async function* streamOnce(p: StreamParams, fields: AdditionalFields): AsyncGenerator<LlmEvent> {
  const res = await bedrock.send(
    new ConverseStreamCommand({
      modelId: p.modelId,
      system: systemBlocks(p.modelId, p.systemPrompt),
      messages: p.messages,
      inferenceConfig: { maxTokens: p.maxTokens },
      additionalModelRequestFields: fields,
    }),
    { abortSignal: p.abortSignal },
  );
  if (!res.stream) throw new Error('ConverseStream returned no stream');

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | undefined;
  for await (const ev of res.stream) {
    const streamErr =
      ev.internalServerException ??
      ev.modelStreamErrorException ??
      ev.validationException ??
      ev.throttlingException ??
      ev.serviceUnavailableException;
    if (streamErr) {
      throw streamErr instanceof Error
        ? streamErr
        : Object.assign(new Error('ConverseStream error event'), { name: 'ModelStreamError' });
    }
    const text = ev.contentBlockDelta?.delta?.text;
    if (text) yield { type: 'delta', text };
    if (ev.messageStop) stopReason = ev.messageStop.stopReason;
    if (ev.metadata?.usage) {
      usage.inputTokens = ev.metadata.usage.inputTokens ?? 0;
      usage.outputTokens = ev.metadata.usage.outputTokens ?? 0;
    }
  }
  yield { type: 'end', usage, stopReason };
}

/**
 * ConverseStream: yields text deltas, then one `end` event with token usage.
 * If model-specific fields were sent and Bedrock rejects the request with a ValidationException
 * before any delta was emitted, retries once without them (and skips them from then on).
 */
export async function* streamAnswer(p: StreamParams): AsyncGenerator<LlmEvent> {
  const fields = requestFieldsFor(p.modelId);
  let emitted = false;
  try {
    for await (const ev of streamOnce(p, fields)) {
      if (ev.type === 'delta') emitted = true;
      yield ev;
    }
  } catch (err) {
    if (fields === undefined || emitted || !isValidationError(err)) throw err;
    markFieldsRejected(p.modelId, err);
    yield* streamOnce(p, undefined);
  }
}

export interface ConverseTextParams {
  modelId: string;
  system: string;
  userText: string;
  maxTokens: number;
}

async function converseOnce(p: ConverseTextParams, fields: AdditionalFields) {
  return bedrock.send(
    new ConverseCommand({
      modelId: p.modelId,
      system: [{ text: p.system }],
      messages: [{ role: 'user', content: [{ text: p.userText }] }],
      inferenceConfig: { maxTokens: p.maxTokens },
      additionalModelRequestFields: fields,
    }),
  );
}

/** Non-streaming Converse returning concatenated text (used for the search-query rewrite). */
export async function converseText(p: ConverseTextParams): Promise<{ text: string; usage: Usage }> {
  const fields = requestFieldsFor(p.modelId);
  let res: Awaited<ReturnType<typeof converseOnce>>;
  try {
    res = await converseOnce(p, fields);
  } catch (err) {
    if (fields === undefined || !isValidationError(err)) throw err;
    markFieldsRejected(p.modelId, err);
    res = await converseOnce(p, undefined);
  }
  const content: ContentBlock[] = res.output?.message?.content ?? [];
  const text = content.map((b) => b.text ?? '').join('');
  return {
    text,
    usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
  };
}
