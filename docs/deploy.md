# Deploy, operate & tear down

Step-by-step for the human owner. Agents never run `cdk deploy`/`bootstrap`/`destroy` or mutating AWS CLI commands.
Default region `ap-northeast-1`; all commands assume your AWS credentials/profile point to the target account.

## 0. Prerequisites

- Node.js ≥ 20, npm, AWS CLI v2, credentials for an admin-ish role in the target account.
- **Bedrock model access** (tasks H2): in ap-northeast-1, open the Bedrock console, enable the chat model and
  `amazon.titan-embed-text-v2:0`, and send one test prompt to the chat model from the console playground (first-time Claude use goes through Marketplace, and the Lambda isn't given Marketplace permissions).
  Find the inference profile id:
  ```bash
  aws bedrock list-inference-profiles --region ap-northeast-1 \
    --query 'inferenceProfileSummaries[].inferenceProfileId' --output table
  ```
- Corporate TLS interception: if `npm` fails with `SELF_SIGNED_CERT_IN_CHAIN`, prefix npm/npx commands with
  `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem` (don't change the global npm config).

## 1. Configure `infra/cdk.json`

Edit `context` (anything can also be overridden per command with `-c key=value`):

| Key | Set to |
|---|---|
| `modelId` | inference profile id from step 0 (replace the `CHANGE-ME-...` placeholder) |
| `queryRewriteModelId` | *optional*: cheaper model for follow-up query rewriting (default: `modelId`) |
| `modelEffort` | `off` \| `low` (default) \| `medium` \| `high` \| `xhigh` \| `max` |
| `budget.email` | address that receives budget alerts |
| `budget.monthlyLimitUsd` / `alertThresholdsUsd` | default 100 / [10, 30, 60] |
| `cognitoDomainPrefix` | globally unique, lowercase, no `aws`/`amazon`/`cognito`, e.g. `pmbok-assistant-<account-id>` |
| `owner` | value for the `owner` tag |
| `okta` | leave **absent** for the first deploy (see step 5) |
| `reservedConcurrency` | leave absent (ADR-011) |

`npx cdk synth` warns while any `CHANGE-ME` placeholder is left. Don't deploy with placeholders.

## 2. Build & verify locally

```bash
(cd backend  && npm ci && npm test)
(cd frontend && npm ci && npm run build)      # produces frontend/dist (deployed by Pmbok-Frontend)
(cd infra    && npm ci && npm test && npx cdk synth --all -q)
```
Synth must print **no** `STUB` warning (it means `backend/` wasn't found) and **no** "Frontend build not found" warning.
`backend/node_modules` must exist: NodejsFunction runs `esbuild` from there.

## 3. First deploy

```bash
cd infra
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://$ACCOUNT/ap-northeast-1      # once per account/region
npx cdk deploy --all                                  # review IAM changes when prompted
```
Order is automatic: Ops, Auth, Data → Knowledge → Api → Frontend. Note these outputs:

| Stack | Output | Used for |
|---|---|---|
| Pmbok-Frontend | `CloudFrontUrl` | the app URL |
| Pmbok-Auth | `UserPoolId`, `CognitoDomain` | admin users, debugging |
| Pmbok-Auth | `OktaRedirectUri` | Okta app sign-in redirect URI (step 5) |
| Pmbok-Knowledge | `KnowledgeBaseId`, `DataSourceId` | upload script (step 6) |
| Pmbok-Data | `DocsBucketName` | upload script (step 6) |

To show them again later: `aws cloudformation describe-stacks --stack-name Pmbok-Frontend --query 'Stacks[0].Outputs'`.

Budget email subscriptions need no confirmation; verify the budget under Billing → Budgets.

## 4. Admin fallback user (works without Okta)

Self sign-up is disabled. Create a native Cognito user:
```bash
POOL=$(aws cloudformation describe-stacks --stack-name Pmbok-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
```
A temporary password is emailed; you set a new one at first login.

## 5. Okta hookup

1. In Okta Admin: **Applications → Create App Integration → OIDC → Web Application**.
   - Grant type: Authorization Code.
   - Sign-in redirect URI: the `OktaRedirectUri` output, i.e. `https://<cognitoDomainPrefix>.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse`.
   - Assignments: the POC users/group.
2. Store the Okta **client secret** as a plain-string secret:
   ```bash
   aws secretsmanager create-secret --region ap-northeast-1 \
     --name pmbok/okta-client-secret --secret-string '<okta client secret>'
   ```
3. Add to `infra/cdk.json` → `context`:
   ```json
   "okta": {
     "issuerUrl": "https://<your-org>.okta.com",
     "clientId": "<okta client id>",
     "clientSecretName": "pmbok/okta-client-secret"
   }
   ```
   `issuerUrl` is the org authorization server (`https://<org>.okta.com`) unless you use a custom one (`.../oauth2/default`).
4. `cd infra && npx cdk deploy --all` (updates Pmbok-Auth with the `Okta` IdP and Pmbok-Frontend's app client to allow `Okta` + `COGNITO`).
5. Users now see an "Okta" button on the Cognito login page. Users sign in with their email (mapped from Okta).

If you rotate the Okta secret, update it in Secrets Manager and redeploy Pmbok-Auth (CloudFormation reads the secret at deploy time).

## 6. Upload PMBOK + ingest

Put the licensed PDFs in `pmbok-source/` (git-ignored). Filenames that contain a standalone `6` or `7`
(`PMBOK_6th.pdf`, `pmbok-7.pdf`) get their edition inferred; otherwise pass it explicitly.

```bash
scripts/upload-pmbok.sh --dry-run                       # shows files + metadata, writes nothing
scripts/upload-pmbok.sh                                 # sync to s3://<docs>/pmbok/, ingest, wait
scripts/upload-pmbok.sh --edition "PMBOK Guide.pdf=7"   # when the name doesn't tell
```
The script syncs `pmbok/` with `--delete` (the folder mirrors `pmbok-source/`), writes a
`<file>.pdf.metadata.json` sidecar (`source=pmbok`, `edition`, `title`), starts an ingestion job and polls it
until `COMPLETE` (it prints document statistics; non-zero exit on `FAILED`). Ingesting two books takes a few minutes.
Re-run it any time the PDFs change.

## 7. Smoke test

```bash
CF=$(aws cloudformation describe-stacks --stack-name Pmbok-Frontend \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" --output text)
FNURL=$(aws cloudformation describe-stacks --stack-name Pmbok-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionUrl'].OutputValue" --output text)

curl -s "$CF/config.json"                          # {region,userPoolId,clientId,cognitoDomain}
curl -s -o /dev/null -w '%{http_code}\n' "$CF/some/deep/link"   # 200 (index.html, SPA routing)
curl -s -w '\n%{http_code}\n' "$CF/api/me"         # 401 + JSON error (NOT index.html)
curl -s -o /dev/null -w '%{http_code}\n' "${FNURL}api/me"       # 403 — Function URL not callable directly
```
In the browser:
1. Open `$CF`, sign in (admin user or Okta).
2. Ask: "My sponsor keeps changing scope mid-sprint. What should I do?" — the answer streams, shows `[n]` citations with edition/page.
3. Reload: the session is in the sidebar with its history. Delete it.
4. `GET /api/me` usage count went up (browser devtools).
5. CloudWatch Logs → the api function's log group: entries contain `sub`, route, latency, token usage — no tokens or message bodies.

Common failures:
| Symptom | Likely cause |
|---|---|
| `/api/*` returns 403 from CloudFront for every call | Lambda permission for CloudFront missing (`lambda:InvokeFunctionUrl` + `lambda:InvokeFunction` via URL) — check the Pmbok-Frontend Lambda permissions |
| GET works, POST returns 403 "signature does not match" | client didn't send `x-amz-content-sha256` = hex SHA-256 of the exact body |
| 500 on chat, logs show `AccessDeniedException` from Bedrock | model access not enabled, wrong `modelId`, or Marketplace subscription not done (step 0) |
| Chat answers with "No relevant PMBOK passages found" | ingestion not run or failed (step 6) |
| Deploy fails on `UserPoolDomain` | `cognitoDomainPrefix` already taken — pick another |

## 8. Updating

- Backend code: `cd infra && npx cdk deploy Pmbok-Api`
- Frontend: `(cd frontend && npm run build) && (cd infra && npx cdk deploy Pmbok-Frontend)` (CloudFront cache is invalidated automatically)
- Config change: edit `cdk.json`, `npx cdk diff`, `npx cdk deploy --all`

Cross-stack references use CDK "weak" references (`Fn::GetStackOutput`), so stacks aren't locked by exports.
Always deploy/destroy with `--all` (or in dependency order) to keep consumers consistent.

## 9. Tear down (end of POC)

```bash
cd infra && npx cdk destroy --all
```
Buckets are emptied automatically; DynamoDB table, Cognito pool, vector bucket/index and KB are deleted.
Left behind (delete manually if you want zero residue):
- Secrets Manager secret `pmbok/okta-client-secret` (`aws secretsmanager delete-secret --secret-id pmbok/okta-client-secret --recovery-window-in-days 7`)
- The CDK bootstrap stack `CDKToolkit` and its assets bucket (only if nothing else in the account uses CDK)
- Any CloudWatch log groups not owned by the stacks (e.g. from earlier failed deploys)
- The AWS Budget is in Pmbok-Ops and is removed with it.
