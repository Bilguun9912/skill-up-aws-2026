import {
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
  type RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { agentRuntime } from './aws.js';
import { getConfig } from './config.js';
import type { RetrievedChunk } from './prompt.js';
import { collapseWhitespace, truncateCodePoints } from './text.js';
import type { Citation } from './types.js';

export const EXCERPT_MAX_CHARS = 300;
/** Defensive cap on the retrieval query length (KB query limits are not verified here). */
export const RETRIEVE_QUERY_MAX_CHARS = 1000;
export const PAGE_METADATA_KEY = 'x-amz-bedrock-kb-document-page-number';

/** Phase 1: PMBOK only. Phase 2 will add `orAll: [source = pmbok, ownerSub = <sub>]`. */
export const PMBOK_FILTER: RetrievalFilter = { equals: { key: 'source', value: 'pmbok' } };

type Metadata = Record<string, unknown> | undefined;

function metaString(meta: Metadata, key: string): string | undefined {
  const v = meta?.[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function metaPage(meta: Metadata): number | undefined {
  const v = meta?.[PAGE_METADATA_KEY];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function normaliseEdition(v: string | undefined): '6' | '7' | undefined {
  const m = v?.match(/^(6|7)/);
  return m ? (m[1] as '6' | '7') : undefined;
}

/** Maps one KB result to a citation + the chunk text used in the prompt. */
export function toRetrievedChunk(result: KnowledgeBaseRetrievalResult, n: number): RetrievedChunk | undefined {
  const text = result.content?.text ?? '';
  if (!text.trim()) return undefined;
  const meta = result.metadata as Metadata;

  const source: Citation['source'] = metaString(meta, 'source') === 'user' ? 'user' : 'pmbok';
  const edition = normaliseEdition(metaString(meta, 'edition'));
  const title =
    metaString(meta, 'title') ??
    (source === 'pmbok' ? (edition ? `PMBOK Guide ${edition}th Edition` : 'PMBOK Guide') : 'Document');

  const citation: Citation = {
    n,
    source,
    title,
    excerpt: truncateCodePoints(collapseWhitespace(text), EXCERPT_MAX_CHARS),
  };
  if (edition) citation.edition = edition;
  const page = metaPage(meta);
  if (page !== undefined) citation.page = page;
  if (typeof result.score === 'number') citation.score = result.score;
  return { citation, text };
}

export function mapRetrievalResults(results: KnowledgeBaseRetrievalResult[]): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  for (const r of results) {
    const chunk = toRetrievedChunk(r, out.length + 1);
    if (chunk) out.push(chunk);
  }
  return out;
}

/** KB Retrieve (top-k, `source = pmbok`). Numbering is 1..n in returned order. */
export async function retrieve(query: string): Promise<RetrievedChunk[]> {
  const { knowledgeBaseId, retrieveTopK } = getConfig();
  const res = await agentRuntime.send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: truncateCodePoints(query, RETRIEVE_QUERY_MAX_CHARS, '') },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: retrieveTopK, filter: PMBOK_FILTER },
      },
    }),
  );
  return mapRetrievalResults(res.retrievalResults ?? []);
}
