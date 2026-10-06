# Security

Internal POC, ~10 users, no VPC (see ADR-001). Security comes from identity, IAM, and cost limits.

## Threats & controls

| Threat | Controls |
|---|---|
| **Denial of wallet** (LLM spend abuse) — top risk | Okta/Cognito auth on every API call · Function URL `AWS_IAM` + CloudFront OAC (no direct calls) · per-user daily quota (DynamoDB) · `maxTokens` cap · message length ≤ 4000 chars · history limited to last N turns · AWS Budgets alerts · optional Lambda reserved concurrency |
| Unauthorized access | Cognito self sign-up **disabled**; only Okta-assigned users (or admin-created Cognito users) can log in · JWT verified (signature, `token_use=access`, `client_id`, expiry) with `aws-jwt-verify` |
| Cross-user data access | All DynamoDB keys built from verified `sub`; never trust ids from the client alone. Phase 2: S3 upload keys prefixed `uploads/<sub>/`, KB retrieval filtered by `ownerSub` |
| DDoS / bots | CloudFront + Shield Standard (free). Phase 2 option: WAF web ACL (us-east-1) with rate-based rule + office/VPN IP allowlist |
| Data exposure (S3) | Block Public Access on all buckets, `enforceSSL`, SSE-S3, OAC-only access to site bucket, docs bucket private |
| Copyrighted material (PMBOK) | PDFs never committed to git (`pmbok-source/` git-ignored), docs bucket private, prompt limits verbatim quoting, app restricted to licensed internal users |
| Prompt injection (via retrieved/uploaded text) | Model has no tools/actions; retrieved text is wrapped as data in the prompt; system prompt states sources are reference material, not instructions |
| Secrets | Okta client secret in Secrets Manager; no secrets in code, cdk.json, or env vars |
| Least privilege | api Lambda: DynamoDB on one table, `bedrock:Retrieve` on one KB, `bedrock:InvokeModelWithResponseStream` on the configured inference profile + its foundation models, `ssm:GetParameter` on one param. KB role: read docs bucket, S3 Vectors on one index, invoke embedding model |
| Audit | CloudTrail management events (default, free) · Lambda logs (no message bodies or tokens logged; log `sub`, route, latency, token usage) · log retention 30 days |

## Rules for code

- Never log JWTs, full prompts, or full model responses. Usage numbers and ids only.
- Validate all input (zod) at the handler boundary.
- Return generic error messages to clients; details go to logs.
- All S3 buckets: `blockPublicAccess: BLOCK_ALL`, `enforceSSL: true`. POC buckets use `RemovalPolicy.DESTROY` + `autoDeleteObjects` so `cdk destroy` leaves nothing billing.
