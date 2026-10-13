/**
 * Fake Bedrock for local dev (BEDROCK_MODE=fake). Patches the SDK clients with
 * aws-sdk-client-mock so the real backend code paths (retrieve → prompt → stream) still run.
 *
 * The excerpts below are placeholder text written for this project — NOT quotes from PMBOK.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { mockClient } from 'aws-sdk-client-mock';

const JA = /[぀-ヿ㐀-鿿]/;

const FAKE_CHUNKS = [
  {
    edition: '7',
    page: 31,
    text: '[Sample excerpt — local fake mode] Stakeholder engagement is an ongoing activity: identify stakeholders early, understand their interests, and keep communicating as the project changes.',
  },
  {
    edition: '7',
    page: 58,
    text: '[Sample excerpt — local fake mode] Teams should tailor their approach (predictive, adaptive or hybrid) to the project context, and revisit that choice as they learn more.',
  },
  {
    edition: '6',
    page: 113,
    text: '[Sample excerpt — local fake mode] Changes to scope are reviewed through a defined change control process; approved changes update the baseline and are communicated to the team.',
  },
];

function lastUserText(input: { messages?: { role?: string; content?: { text?: string }[] }[] }): string {
  const msgs = input.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'user') return (m.content ?? []).map((c) => c.text ?? '').join('\n');
  }
  return '';
}

/** Pulls the user's question out of the assembled prompt (`<question>…</question>`), if present. */
function extractQuestion(prompt: string): string {
  const m = prompt.match(/<question>\s*([\s\S]*?)\s*<\/question>/);
  return (m?.[1] ?? prompt).trim();
}

function fakeAnswer(question: string): string {
  const q = question.length > 120 ? `${question.slice(0, 120)}…` : question;
  if (JA.test(question)) {
    return [
      `> **ローカル・フェイクモード** — これはテスト用の固定回答です（Bedrock は呼び出していません）。`,
      ``,
      `**ご質問:** ${q}`,
      ``,
      `### 推奨アクション`,
      `1. 主要なステークホルダーを洗い出し、関心事を確認する [1]`,
      `2. プロジェクトの状況に合わせて進め方をテーラリングする [2]`,
      `3. スコープ変更は変更管理プロセスを通して扱う [3]`,
      ``,
      `### PMBOK の観点`,
      `- ステークホルダー・エンゲージメント（Stakeholder Engagement）`,
      `- テーラリング（Tailoring）`,
    ].join('\n');
  }
  return [
    `> **Local fake mode** — this is a canned test answer (Bedrock was not called).`,
    ``,
    `**Your question:** ${q}`,
    ``,
    `### Recommended actions`,
    `1. Identify the key stakeholders and confirm their interests [1]`,
    `2. Tailor the delivery approach to the project context [2]`,
    `3. Route scope changes through change control [3]`,
    ``,
    `### PMBOK perspective`,
    `- Stakeholder Engagement performance domain`,
    `- Tailoring`,
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* streamText(text: string) {
  yield { messageStart: { role: 'assistant' } };
  // Stream in small pieces so the UI's streaming behaviour is visible.
  const pieces = [...text].reduce<string[]>((acc, ch, i) => {
    if (i % 6 === 0) acc.push(ch);
    else acc[acc.length - 1] += ch;
    return acc;
  }, []);
  for (const p of pieces) {
    await sleep(15);
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: p } } };
  }
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: 'end_turn' } };
  const outputTokens = Math.ceil([...text].length / 3);
  yield { metadata: { usage: { inputTokens: 1000, outputTokens, totalTokens: 1000 + outputTokens }, metrics: { latencyMs: 0 } } };
}

export function installFakeLlm(): void {
  const rt = mockClient(BedrockRuntimeClient);
  rt.on(ConverseStreamCommand).callsFake(async (input) => ({
    stream: streamText(fakeAnswer(extractQuestion(lastUserText(input)))),
  }));
  // Non-streaming Converse = the JA→EN search-query rewrite.
  rt.on(ConverseCommand).callsFake(async () => ({
    output: { message: { role: 'assistant', content: [{ text: 'stakeholder engagement scope change control' }] } },
    usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
    stopReason: 'end_turn',
  }));
}

export function installFakeRetrieve(): void {
  mockClient(BedrockAgentRuntimeClient)
    .on(RetrieveCommand)
    .resolves({
      retrievalResults: FAKE_CHUNKS.map((c, i) => ({
        content: { text: c.text },
        location: { type: 'S3', s3Location: { uri: `s3://local-fake/pmbok/pmbok-${c.edition}.pdf` } },
        metadata: {
          source: 'pmbok',
          edition: c.edition,
          title: `PMBOK Guide ${c.edition}th Edition (sample)`,
          'x-amz-bedrock-kb-document-page-number': c.page,
        },
        score: 0.9 - i * 0.1,
      })),
    });
}
