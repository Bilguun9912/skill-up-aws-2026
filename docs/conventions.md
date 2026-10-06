# Conventions & Gotchas

## General
- TypeScript everywhere, `strict: true`. Node.js 22 runtime on Lambda (`arm64`). Local Node ≥ 20.
- ESM in backend/frontend; CDK app may be CommonJS (default `cdk init` style) — either is fine, be consistent within a package.
- Each package (`infra/`, `backend/`, `frontend/`) has its own `package.json`, lockfile, `tsconfig.json`, and `npm test`.
- Tests: `vitest` for backend/frontend, `jest` or `vitest` for infra (CDK `Template` assertions). Mock AWS SDK with `aws-sdk-client-mock`.
- Lint/format: Prettier defaults (2 spaces, single quotes, semicolons). ESLint optional.
- Never commit: PMBOK PDFs (`pmbok-source/`), `cdk.out/`, `node_modules/`, `.env*`, `dist/`.
- No real AWS calls in tests or by agents. **Agents must not run `cdk deploy`, `cdk bootstrap`, or any mutating AWS CLI command.** `cdk synth` is fine.

## Naming
- Stacks: `Pmbok-<Name>` (`Pmbok-Ops`, `Pmbok-Auth`, `Pmbok-Data`, `Pmbok-Knowledge`, `Pmbok-Api`, `Pmbok-Frontend`). Stage suffix optional later.
- Let CDK generate physical names (except the SSM param `/pmbok/<stage>/cognito/client-id` and the Cognito domain prefix).
- Tags on all resources: `project=pmbok-assistant`, `env=<stage>`, `owner=<config>`.

## Config (`infra/lib/config.ts`)
Read from CDK context (`cdk.json` → `context`, overridable with `-c key=value`). Typed + validated at synth.
```ts
interface AppConfig {
  stage: string;                    // "dev"
  region: string;                   // "ap-northeast-1"
  modelId: string;                  // Bedrock inference profile id (confirm via list-inference-profiles)
  embeddingModelId: string;         // "amazon.titan-embed-text-v2:0"
  embeddingDimensions: number;      // 1024
  queryRewriteModelId?: string;     // optional cheaper model for JA→EN search-query rewrite (default: modelId)
  dailyQuestionLimit: number;       // 30
  maxOutputTokens: number;          // 2000
  budget: { monthlyLimitUsd: number; alertThresholdsUsd: number[]; email: string };  // 100, [10,30,60]
  cognitoDomainPrefix: string;      // globally unique, e.g. "pmbok-assistant-<account>"
  okta?: { issuerUrl: string; clientId: string; clientSecretName: string }; // secret in Secrets Manager
  localDevOrigins: string[];        // ["http://localhost:5173"] → added to Cognito callback/logout URLs
  reservedConcurrency?: number;     // off by default (see ADR-011)
  modelEffort: string;              // "low" | "off" | medium|high|xhigh|max → env MODEL_EFFORT
  historyTurns: number;             // 5 → env HISTORY_TURNS
  retrieveTopK: number;             // 6 → env RETRIEVE_TOP_K
  owner: string;                    // tag value, default "pmbok-poc"
  account?: string;
  apiCodeStub: boolean;             // tests only: inline 503 Lambda instead of bundling backend/
}
```

## CDK specifics
- Cross-stack refs are **weak** (`Fn::GetStackOutput`, no Exports) → always `cdk deploy --all` / `cdk destroy --all`.
- Function URL needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (`InvokedViaFunctionUrl`) for CloudFront.
- Bundling requires `esbuild` in `backend/` devDependencies (`npm ci` in backend/ before synth).
- Local npm behind TLS interception: `export NODE_EXTRA_CA_CERTS=<corporate root CA pem>`.
- Lambda: `NodejsFunction` with `entry: ../backend/src/handlers/api.ts`, `projectRoot: ../backend`, `depsLockFilePath: ../backend/package-lock.json`, `runtime: NODEJS_22_X`, `architecture: ARM_64`, `timeout: 120s`, `memorySize: 512`, log retention 30 days, bundling `format: ESM`, `minify`, `sourceMap`.
- Function URL: `authType: AWS_IAM`, `invokeMode: RESPONSE_STREAM`.
- CloudFront → Function URL: use `origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl)`; behavior `/api/*`, `allowedMethods: ALLOW_ALL`, `cachePolicy: CACHING_DISABLED`, origin request policy `ALL_VIEWER_EXCEPT_HOST_HEADER`. Confirm it does not forward viewer `Authorization` in a way that breaks OAC — if needed create a custom policy forwarding only `x-auth-token`, `x-amz-content-sha256`, `content-type`, all query strings.
- CloudFront → S3 site: `S3BucketOrigin.withOriginAccessControl`, default root `index.html`, SPA fallback (403/404 → `/index.html` 200) — **only for the default behavior**; don't mask API 404s (use a CloudFront Function on the default behavior for SPA routing if error responses would also apply to `/api/*`).
- S3 Vectors / Bedrock KB: L1 constructs (`CfnVectorBucket`, `CfnIndex` from `aws-cdk-lib/aws-s3vectors`, `bedrock.CfnKnowledgeBase`, `bedrock.CfnDataSource`). Check the installed `aws-cdk-lib` version exposes them; upgrade if not.
- api Lambda IAM (from backend): `bedrock:InvokeModel` (non-streaming rewrite) + `bedrock:InvokeModelWithResponseStream`, `bedrock:Retrieve`, `ssm:GetParameter`, DynamoDB `GetItem, Query, UpdateItem, BatchWriteItem, TransactWriteItems, ConditionCheckItem, PutItem` on the table.
- Bedrock IAM for inference profiles: allow `bedrock:InvokeModel*` on the inference-profile ARN **and** `arn:aws:bedrock:*::foundation-model/<model>` (profile routes cross-region). First-time Marketplace (Claude) use may also need `aws-marketplace:ViewSubscriptions`/`Subscribe` — do the first invocation manually from the console as an admin instead of granting these to Lambda.

## Backend specifics
- Streaming handler: `awslambda.streamifyResponse` (global in the Lambda Node runtime — declare types in `src/types/awslambda.d.ts`; provide a local shim for tests). Set status/headers via `awslambda.HttpResponseStream.from(stream, { statusCode, headers })`.
- Function URL event: payload format 2.0 (`rawPath`, `requestContext.http.method`, `headers` lowercased, `body` possibly base64 with `isBase64Encoded`).
- Libraries: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock-agent-runtime`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-ssm`, `aws-jwt-verify`, `zod`. Create SDK clients once at module scope.
- Structure: `handlers/api.ts` (router) → `routes/*.ts` → `lib/*.ts` (auth, db, quota, retrieve, llm, prompt, ndjson). Pure functions where possible for testability.

## Frontend specifics
- Vite + React + TypeScript. Auth: `oidc-client-ts` + `react-oidc-context` against Cognito (authority `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, PKCE, `response_type=code`). Send the **access token** in `x-auth-token`.
- Load `/config.json` at startup (`{ region, userPoolId, clientId, cognitoDomain }`) before creating the OIDC client. In dev, put a `public/config.json` (git-ignored) or use Vite proxy.
- Body hash: compute with `crypto.subtle.digest('SHA-256', bytes)` → hex → `x-amz-content-sha256`. Hash the exact string you send.
- Streaming: `fetch` + `response.body.getReader()` + `TextDecoder`, split on `\n`, parse each NDJSON line.
- Markdown rendering: `react-markdown` + `remark-gfm`. Render `[n]` as clickable chips that reveal the citation (edition, page, excerpt).
- Dev: `vite` dev server proxies `/api` → `VITE_API_PROXY_TARGET` (deployed CloudFront URL).
- **Bilingual UI (ja/en):** strings in `src/i18n/{en,ja}.ts`; default from `navigator.language`, header toggle persisted in localStorage; send `x-ui-lang`.
- **IME:** Enter-to-send must ignore Japanese IME composition (`e.nativeEvent.isComposing` / keyCode 229).
- Count text length in code points (`[...str].length`). Font stack includes Hiragino Sans / Noto Sans JP / Yu Gothic.
- Keep UI simple and clean; plain CSS modules or a small utility CSS — no heavy UI framework required.
