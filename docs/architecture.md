# Architecture — PMBOK Assistant (POC)

A ChatGPT-style assistant that guides project managers using the **PMBOK Guide (6th and 7th editions)**.
Users sign in with **Okta**, ask questions about their real project situations, and get advice grounded in
PMBOK with **source citations**. Chat history is saved.

- **Users:** ~10 (internal). **Duration:** ~1 month POC. **Budget:** AWS credits only (~$20–70 total expected).
- **Region:** `ap-northeast-1` (Tokyo), configurable.
- **IaC:** AWS CDK (TypeScript). **All code:** TypeScript.

## Diagram

```
                 ┌─────────┐   OIDC    ┌──────────────────────────┐
                 │  Okta   │◀────────▶ │ Cognito User Pool        │
                 └─────────┘           │  + managed login domain  │
                                       │  + Okta OIDC IdP         │
                                       └────────────┬─────────────┘
                                                    │ access token (JWT)
 Browser (React SPA) ──HTTPS──▶ CloudFront ─────────┤
                                 ├─ /*      → S3 site bucket (OAC)        [SPA + config.json]
                                 └─ /api/*  → Lambda Function URL (OAC, AWS_IAM auth, RESPONSE_STREAM)
                                                    │
                                     ┌──────────────▼───────────────┐
                                     │  api Lambda (Node 22, arm64) │
                                     │  - verify JWT (x-auth-token) │
                                     │  - per-user daily quota      │
                                     │  - routes /api/*             │
                                     └──┬────────────┬──────────┬───┘
                                        │            │          │
                          ┌─────────────▼──┐  ┌──────▼─────┐  ┌─▼─────────────────────────────┐
                          │ DynamoDB       │  │ Bedrock KB │  │ Bedrock ConverseStream         │
                          │ (single table) │  │ Retrieve   │  │ Claude Sonnet 5.5 (default)    │
                          │ sessions/msgs/ │  └──────┬─────┘  │ or Amazon Nova (fallback)      │
                          │ usage          │         │        └────────────────────────────────┘
                          └────────────────┘  ┌──────▼──────────────────────────────┐
                                              │ S3 Vectors (vector bucket + index)  │
                                              │  ▲ Titan Text Embeddings v2 (1024d) │
                                              │  │ ingestion job                    │
                                              │ S3 docs bucket: pmbok/*.pdf + .metadata.json
                                              └─────────────────────────────────────┘

 Ops: AWS Budgets (email alerts) · CloudWatch Logs · CloudTrail (default) · Bedrock invocation logs (optional)
```

## Request flow (chat)

1. SPA signs the user in via Cognito managed login → redirects to Okta → back with an auth code (PKCE).
2. SPA calls `POST /api/chat` with header `x-auth-token: <Cognito access token>` and `x-amz-content-sha256: <hex sha256 of body>`.
3. CloudFront signs the request to the Function URL with OAC (SigV4). Direct calls to the Function URL are rejected (AWS_IAM auth).
4. Lambda verifies the JWT, checks/increments the user's daily quota, loads the last N messages of the session.
5. Lambda calls Bedrock KB `Retrieve` (top-k chunks; filter `source = pmbok`, later also `ownerSub = <user>`).
6. Lambda builds the prompt (system prompt + numbered sources + history + question) and calls `ConverseStream`.
7. Lambda streams NDJSON events (`session`, `citations`, `delta`..., `done`) back through CloudFront to the browser.
8. On completion, the user message + assistant message (with citations, token usage) are written to DynamoDB.

## CDK stacks

| Stack | Contents | Depends on |
|---|---|---|
| `Pmbok-Ops` | AWS Budget with email alerts (thresholds from config) | — |
| `Pmbok-Auth` | Cognito User Pool, managed login domain, Okta OIDC IdP (when configured) | — |
| `Pmbok-Data` | DynamoDB table, S3 docs bucket | — |
| `Pmbok-Knowledge` | S3 Vectors bucket + index, Bedrock KB (S3_VECTORS), S3 data source, KB service role | Data |
| `Pmbok-Api` | api Lambda (NodejsFunction), Function URL (AWS_IAM, RESPONSE_STREAM), IAM | Auth, Data, Knowledge |
| `Pmbok-Frontend` | S3 site bucket, CloudFront distribution (OAC to S3 + Lambda URL), User Pool **Client**, SSM param with client id, `config.json` deployment, Lambda invoke permission for the distribution | Auth, Api |

**Why the User Pool Client lives in `Pmbok-Frontend`:** its callback URL needs the CloudFront domain, and the
distribution needs the Function URL. If the Lambda referenced the client id directly we'd get a cycle.
So the Lambda gets the client id at cold start from SSM parameter `/pmbok/<stage>/cognito/client-id`
(deterministic name, no CloudFormation reference). See ADR-006.

## Repository layout

```
skill-up-aws-2026/
├── CLAUDE.md                 # entry point for agents
├── docs/                     # this folder — source of truth for design
├── infra/                    # CDK app (own package.json)
│   ├── bin/app.ts
│   ├── lib/config.ts
│   ├── lib/stacks/*.ts
│   └── test/
├── backend/                  # Lambda source (own package.json)
│   ├── src/handlers/api.ts   # streaming handler entry (router)
│   ├── src/lib/*.ts
│   ├── src/prompts/system.ts
│   └── test/
├── frontend/                 # Vite + React SPA (own package.json)
├── scripts/                  # upload-pmbok.sh, etc.
└── pmbok-source/             # local-only PDFs (git-ignored!)
```

Each of `infra/`, `backend/`, `frontend/` is an **independent npm package** (no root workspaces) so they can
be developed in parallel without lockfile conflicts. `infra` bundles `backend/src/handlers/api.ts` with
`NodejsFunction` using `projectRoot: ../backend` and `depsLockFilePath: ../backend/package-lock.json`.

## Phases

- **Phase 1 (POC core):** Okta login, streaming chat, chat history, PMBOK citations, quotas, budgets.
- **Phase 2 (nice to have):** users upload their own project docs (presigned S3 PUT to `uploads/<sub>/...`,
  metadata `ownerSub`, KB re-sync), retrieval filter `source=pmbok OR ownerSub=<sub>`. Optional WAF (IP allowlist + rate limit; must be deployed in `us-east-1`).

## Related docs

- [decisions.md](decisions.md) — ADRs (why each choice)
- [api.md](api.md) — HTTP API contract + DynamoDB schema
- [security.md](security.md) — threat model & controls
- [cost.md](cost.md) — cost model & guardrails
- [prompting.md](prompting.md) — system prompt & citation design
- [conventions.md](conventions.md) — coding/config conventions, gotchas
- [tasks.md](tasks.md) — task breakdown & status
