/**
 * Types for the `awslambda` global injected by the AWS Lambda Node.js runtime
 * (response streaming). It does not exist locally; tests install a shim (see test/setup.ts).
 */
import type { Writable } from 'node:stream';

declare global {
  namespace awslambda {
    type ResponseStream = Writable & {
      setContentType?(contentType: string): void;
    };

    interface HttpResponseMetadata {
      statusCode?: number;
      headers?: Record<string, string>;
      cookies?: string[];
    }

    type StreamifyHandler<TEvent = unknown, TContext = unknown> = (
      event: TEvent,
      responseStream: ResponseStream,
      context: TContext,
    ) => Promise<void>;

    function streamifyResponse<TEvent = unknown, TContext = unknown>(
      handler: StreamifyHandler<TEvent, TContext>,
    ): (event: TEvent, context: TContext) => Promise<void>;

    namespace HttpResponseStream {
      function from(stream: ResponseStream, metadata: HttpResponseMetadata): ResponseStream;
    }
  }
}

export {};
