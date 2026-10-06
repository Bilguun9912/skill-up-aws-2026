# Architecture Decision Records

Short ADRs. Status: Accepted unless noted. Add new ones at the bottom; don't rewrite history — supersede.

## ADR-001 Serverless, no VPC
**Decision:** Lambda + DynamoDB + S3 + Bedrock, no VPC.
**Why:** No resource we own exposes a network endpoint; all services are IAM-authenticated over TLS. A VPC would add
NAT (~$35/mo) or interface endpoints (~$7–8/mo each/AZ) without reducing the public surface (CloudFront exists either way).
**Revisit if:** we add RDS/EC2/ECS, or company policy requires private connectivity to Bedrock (then: VPC + interface endpoints, no NAT).

## ADR-002 Vector store = S3 Vectors (not OpenSearch Serverless)
**Decision:** Bedrock Knowledge Base with `S3_VECTORS` storage.
**Why:** OpenSearch Serverless has an always-on minimum OCU charge that would burn credits with zero traffic. S3 Vectors is pay-per-use, cents at this scale.
**Gotcha:** the index must declare `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` as **non-filterable** metadata keys (filterable metadata is size-limited). Verify current CFN property names for `AWS::S3Vectors::Index` and `AWS::Bedrock::KnowledgeBase` `S3VectorsConfiguration` at implementation time.

## ADR-003 Auth = Cognito User Pool federated with Okta (OIDC)
**Decision:** Cognito managed login → Okta OIDC IdP. API validates Cognito **access tokens** with `aws-jwt-verify`.
**Why:** native CDK support, stable `sub` per user, works without Okta during dev (Cognito native users, admin-created only — self sign-up disabled).
**Config:** Okta is optional in config; if `okta` is set, add the IdP and list it in `supportedIdentityProviders` (keep `COGNITO` for an admin fallback user).
Okta client secret is stored in **Secrets Manager** (~$0.40/mo) because CloudFormation dynamic references to SSM SecureString aren't supported for Cognito IdP properties.

## ADR-004 LLM via Bedrock `ConverseStream` (AWS SDK), model id is config
**Decision:** use `@aws-sdk/client-bedrock-runtime` `ConverseStreamCommand`, not the Anthropic SDK.
**Why:** requirement to swap between Claude (Marketplace-billed — may not be covered by credits) and Amazon Nova (first-party) by changing one config value. Converse is model-agnostic.
**Default:** Claude Sonnet 5.5 via a cross-region **inference profile** in ap-northeast-1. Exact id must be confirmed with
`aws bedrock list-inference-profiles --region ap-northeast-1`. Fallback: an Amazon Nova model/profile.
**Model-specific tuning** (e.g. Claude effort `low`) goes through `additionalModelRequestFields`, applied only when the model id contains `anthropic` — verify exact field shape against current Bedrock docs.

## ADR-005 Retrieve + generate ourselves (not RetrieveAndGenerate)
**Decision:** call KB `Retrieve`, then `ConverseStream` with our own prompt.
**Why:** full control over prompt, history, citation numbering, streaming, and model choice.

## ADR-006 User Pool Client in Frontend stack; Lambda reads client id from SSM
**Decision:** see architecture.md. Breaks the Function → Client → Distribution → FunctionUrl → Function cycle.
Lambda caches the SSM value per container.

## ADR-007 Function URL + CloudFront OAC (not API Gateway)
**Decision:** single api Lambda with Function URL, `InvokeMode: RESPONSE_STREAM`, `AuthType: AWS_IAM`, fronted by CloudFront OAC.
**Why:** token streaming with minimal moving parts; Function URL can't be called directly.
**Consequences (important):**
- OAC uses the `Authorization` header for SigV4 → our JWT goes in **`x-auth-token`**, never `Authorization`.
- For requests with a body (POST/PUT), the **client must send `x-amz-content-sha256`** = hex SHA-256 of the body, or the signature fails.
- Origin request policy must forward `x-auth-token`, `x-amz-content-sha256`, `content-type`, query strings — but **not** the viewer `Host`/`Authorization` header (use `AllViewerExceptHostHeader` or a custom policy). Caching disabled for `/api/*`.

## ADR-008 One api Lambda with an internal router
**Decision:** one function handles all `/api/*` routes (streaming mode for all; non-chat routes just write JSON).
**Why:** one Function URL, one CloudFront behavior, fewer cold starts. Fine for ~10 users.

## ADR-009 Independent npm packages (no workspaces)
**Decision:** `infra/`, `backend/`, `frontend/` each have their own `package.json` + lockfile.
**Why:** parallel development by multiple agents without lockfile conflicts.

## ADR-010 Runtime config for the SPA via `config.json`
**Decision:** Frontend stack writes `/config.json` (region, userPoolId, clientId, cognitoDomain) next to the SPA with `BucketDeployment` + `Source.jsonData`. SPA fetches it at startup.
**Why:** no build-time coupling between stacks; same build works for any stage.

## ADR-011 Cost guardrails in code
**Decision:** per-user daily question limit (default 30), `maxTokens` cap on generation, last-N history only, AWS Budget alerts.
Lambda **reserved concurrency is optional** (default off): new accounts often have an account concurrency limit of 10, and AWS requires 10 unreserved, so reserving would fail.
