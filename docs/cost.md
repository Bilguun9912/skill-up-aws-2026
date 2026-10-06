# Cost Model (1-month POC, ~10 users)

Funding: AWS credits ($100 signup + up to $100 activities). **Free tier ≠ credits.** Credits only cover eligible services.

| Item | Covered by | Est. / month |
|---|---|---|
| Lambda, DynamoDB on-demand, CloudFront, Cognito (≤ free MAU), CloudWatch basic, CloudTrail mgmt events | Always-free tier | ~$0 |
| S3 (PDFs, site, uploads) | free tier / credits | < $0.50 |
| Titan Text Embeddings v2 (both PMBOK books, one-time ~1–2M tokens) | credits | ~$0.05 |
| S3 Vectors storage + queries | credits | < $1 |
| Secrets Manager (Okta secret) | credits | $0.40 |
| AWS Budgets (1 budget) | free | $0 |
| WAF (phase 2, optional) | credits | ~$6–8 |
| **LLM: Claude Sonnet 5.5** (~2,200 q/mo × ~8k in / ~1k out) | ⚠️ Marketplace — may NOT be covered by credits | ~$15–60 |
| JA→EN query rewrite for Japanese questions (~200 tokens each) | same as LLM | ~$1–3 |
| **Total** | | **~$20–80** |

Japanese text uses more tokens per character than English, so Japanese-heavy usage costs roughly 20–40% more LLM output tokens for the same answer length. Still within the estimate range.

## ⚠️ Open: are Claude models covered by our credits?
Claude on Bedrock is billed via AWS Marketplace; promotional credits often exclude Marketplace charges, and some
account plans can't subscribe at all. Check **Billing → Credits → applicable products** and try enabling Claude in
**Bedrock → Model access**. If not covered → set `modelId` to an Amazon Nova model/profile (no architecture change).

## Guardrails (implemented in code/config)
- Budget alerts at configured thresholds (default $10 / $30 / $60) to `budgetEmail`.
- Daily per-user question limit (`dailyQuestionLimit`, default 30).
- `maxOutputTokens` 2000, history last 5 turns, top-k 6 chunks.
- Claude effort `low` (chat workload) where supported.
- No always-on resources (no NAT, no OpenSearch Serverless, no RDS).
- End of POC: `npx cdk destroy --all` removes everything (buckets auto-emptied).
