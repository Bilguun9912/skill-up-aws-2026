# Tasks

Status: ☐ todo · ◐ in progress · ☑ done · ⛔ blocked. Agents: report results back to the coordinator; the coordinator updates this file.

## Human (owner) tasks — require AWS console / Okta access
| # | Task | Status |
|---|---|---|
| H1 | Check credits: Billing → Credits → applicable products. Is Bedrock Marketplace (Claude) covered? | ☐ |
| H2 | Bedrock → Model access in ap-northeast-1: enable / first-invoke Claude Sonnet 5.5 (or decide on Nova). Run `aws bedrock list-inference-profiles --region ap-northeast-1` and record the profile id in `infra/cdk.json` (`modelId`) | ☐ |
| H3 | Okta: admin access or free developer org? Create OIDC Web app (redirect URI given after first deploy: `https://<cognito-domain>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse`), assign users, store client secret in Secrets Manager | ☐ |
| H4 | Obtain PMBOK 6th & 7th edition PDFs (licensed copies) → `pmbok-source/` (git-ignored) | ☐ |
| H5 | `npx cdk bootstrap` + `npx cdk deploy --all` (first deploy can run without Okta) | ☐ |
| H6 | Run `scripts/upload-pmbok.sh` to upload PDFs + metadata and start KB ingestion | ☐ |
| H7 | Confirm security policy: is "no VPC" acceptable at Asia Quest? Office/VPN IP ranges for optional WAF? | ☐ |

## Phase 1 — build (agents)
| # | Task | Owner | Depends | Status |
|---|---|---|---|---|
| T0 | Architecture + technical docs | coordinator | — | ☑ |
| T1 | **infra**: CDK app, config, 6 stacks, tests, `cdk synth` passes | infra agent | T0 | ☑ |
| T2 | **backend**: api Lambda (router, auth, quota, sessions, chat streaming w/ Retrieve + ConverseStream, prompts), unit tests | backend agent | T0 | ☑ |
| T3 | **frontend**: Vite React SPA (config.json, OIDC login, chat UI w/ streaming, sessions sidebar, citations), build passes | frontend agent | T0 | ☑ |
| T4 | **scripts**: `upload-pmbok.sh` (sync PDFs + metadata, start ingestion job, poll), smoke test in `docs/deploy.md` §7 | infra agent | T1 | ☑ |
| T5 | Integration review: env var names, API contract, CloudFront headers line up across packages | coordinator | T1–T3 | ☑ |

## Phase 2 — nice to have
| # | Task | Status |
|---|---|---|
| P2-1 | User doc uploads (presign route, uploads prefix, metadata `ownerSub`, ingestion trigger Lambda on S3 event, retrieval OR filter) | ☐ |
| P2-2 | WAF in us-east-1 (rate limit + IP allowlist) | ☐ |
| P2-3 | Prompt tuning with a small eval set of real PM questions | ☐ |
| P2-4 | Model A/B: Sonnet 5.5 vs Haiku 4.5 vs Nova | ☐ |
| P2-5 | Frontend: optional `identityProvider` in config.json to skip Cognito page and go straight to Okta | ☐ |
