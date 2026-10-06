/**
 * Test setup: env vars + a local shim for the `awslambda` global that the Lambda Node.js
 * runtime provides in production.
 */
import type { CaptureStream } from './helpers.js';

process.env.TABLE_NAME = 'TestTable';
process.env.KNOWLEDGE_BASE_ID = 'KB123';
process.env.MODEL_ID = 'apac.anthropic.claude-sonnet-test';
process.env.USER_POOL_ID = 'ap-northeast-1_TestPool';
process.env.CLIENT_ID_PARAM = '/pmbok/test/cognito/client-id';
process.env.DAILY_QUESTION_LIMIT = '30';
process.env.MAX_OUTPUT_TOKENS = '2000';
process.env.HISTORY_TURNS = '5';
process.env.RETRIEVE_TOP_K = '6';
process.env.AWS_REGION = 'ap-northeast-1';
delete process.env.QUERY_REWRITE_MODEL_ID;

(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: (fn: unknown) => fn,
  HttpResponseStream: {
    from(stream: CaptureStream, metadata: awslambda.HttpResponseMetadata) {
      stream.metadata = metadata;
      return stream;
    },
  },
};
