import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/config.js';
import { converseText, resetModelFieldsStateForTests, streamAnswer, type LlmEvent } from '../src/lib/llm.js';
import { converseStreamEvents } from './helpers.js';

const bedrockMock = mockClient(BedrockRuntimeClient);
const EFFORT = { output_config: { effort: 'low' } };

const rejection = () => new ValidationException({ message: 'extraneous key [output_config]', $metadata: {} });

async function collect(): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const ev of streamAnswer({
    modelId: 'apac.anthropic.claude-sonnet-test',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: [{ text: 'SECRET-PROMPT' }] }],
    maxTokens: 100,
  })) {
    out.push(ev);
  }
  return out;
}

const streamFields = () =>
  bedrockMock.commandCalls(ConverseStreamCommand).map((c) => c.args[0].input.additionalModelRequestFields);

describe('model-specific fields safety net', () => {
  beforeEach(() => {
    bedrockMock.reset();
    resetModelFieldsStateForTests();
    resetConfigForTests();
  });
  afterEach(() => {
    delete process.env.MODEL_EFFORT;
    resetConfigForTests();
  });

  it('ValidationException → retries once without fields, warns once, later calls skip fields', async () => {
    const warn = vi.spyOn(console, 'warn');
    bedrockMock
      .on(ConverseStreamCommand)
      .rejectsOnce(rejection())
      .callsFake(async () => ({ stream: converseStreamEvents(['ok']) }));

    const first = await collect();
    expect(first.map((e) => e.type)).toEqual(['delta', 'end']);
    expect(streamFields()).toEqual([EFFORT, undefined]);

    const second = await collect();
    expect(second.map((e) => e.type)).toEqual(['delta', 'end']);
    expect(streamFields()).toEqual([EFFORT, undefined, undefined]);

    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toMatchObject({
      level: 'warn',
      msg: 'model_specific_fields_rejected',
      errName: 'ValidationException',
    });
    expect(warnings[0]).not.toContain('SECRET-PROMPT');
  });

  it('ValidationException delivered as a stream event before any delta also triggers the retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    bedrockMock.on(ConverseStreamCommand).callsFake(async () => {
      n++;
      if (n === 1) {
        return {
          stream: (async function* () {
            yield { validationException: rejection() };
          })(),
        };
      }
      return { stream: converseStreamEvents(['ok']) };
    });
    expect((await collect()).map((e) => e.type)).toEqual(['delta', 'end']);
    expect(streamFields()).toEqual([EFFORT, undefined]);
  });

  it('does not retry on other errors, or once deltas were emitted', async () => {
    bedrockMock.on(ConverseStreamCommand).rejects(new Error('ThrottlingException'));
    await expect(collect()).rejects.toThrow('ThrottlingException');
    expect(streamFields()).toEqual([EFFORT]);

    bedrockMock.reset();
    bedrockMock.on(ConverseStreamCommand).callsFake(async () => ({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial' } } };
        yield { validationException: rejection() };
      })(),
    }));
    await expect(collect()).rejects.toThrow();
    expect(streamFields()).toEqual([EFFORT]);
  });

  it('converseText (query rewrite) retries without fields and shares the per-container memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    bedrockMock
      .on(ConverseCommand)
      .rejectsOnce(rejection())
      .resolves({ output: { message: { role: 'assistant', content: [{ text: 'risk register' }] } } });
    bedrockMock.on(ConverseStreamCommand).callsFake(async () => ({ stream: converseStreamEvents(['ok']) }));

    const res = await converseText({ modelId: 'apac.anthropic.x', system: 's', userText: 'u', maxTokens: 100 });
    expect(res.text).toBe('risk register');
    const conv = bedrockMock.commandCalls(ConverseCommand).map((c) => c.args[0].input.additionalModelRequestFields);
    expect(conv).toEqual([EFFORT, undefined]);

    await collect();
    expect(streamFields()).toEqual([undefined]);
  });

  it('MODEL_EFFORT=off sends no model-specific fields', async () => {
    process.env.MODEL_EFFORT = 'off';
    resetConfigForTests();
    bedrockMock.on(ConverseStreamCommand).callsFake(async () => ({ stream: converseStreamEvents(['ok']) }));
    await collect();
    expect(streamFields()).toEqual([undefined]);
  });

  it('MODEL_EFFORT=medium is passed through', async () => {
    process.env.MODEL_EFFORT = 'medium';
    resetConfigForTests();
    bedrockMock.on(ConverseStreamCommand).callsFake(async () => ({ stream: converseStreamEvents(['ok']) }));
    await collect();
    expect(streamFields()).toEqual([{ output_config: { effort: 'medium' } }]);
  });
});
