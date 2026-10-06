# CI/CD — GitHub Actions

Deploys use **GitHub OIDC → IAM role**. There are no AWS access keys in GitHub.

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | every PR (and called by deploy) | per package: `npm ci`, `tsc --noEmit`, `npm test`; frontend build; `cdk synth --all` (no AWS credentials) |
| `.github/workflows/deploy.yml` | push to `main` (except docs/markdown-only changes), manual run | runs CI → applies config from GitHub variables → `cdk deploy --all -c strictConfig=true` → smoke test |

```
push main ─▶ CI (test ×3, synth) ─▶ deploy job (environment "dev")
                                     ├─ GitHub OIDC token ─▶ sts:AssumeRoleWithWebIdentity ─▶ GithubDeployRole
                                     │                                                       └─ may only assume cdk-* bootstrap roles
                                     ├─ cdk deploy --all  (CloudFormation execution role makes the changes)
                                     └─ smoke test: site 200 · config.json valid · /api/me without token → 401
```

## Security model
- The deploy role trusts **only** `repo:Bilguun9912/skill-up-aws-2026:environment:dev` (audience `sts.amazonaws.com`).
  PRs, forks, and other branches can't get AWS credentials. Only jobs that run in the `dev` environment can.
- The role's only permissions are to assume the CDK bootstrap roles (`deploy`, `file-publishing`, `image-publishing`, `lookup`, matched by their `aws-cdk:bootstrap-role` tag) and to read `Pmbok-*` stack outputs.
- `strictConfig=true` makes synth fail if any `CHANGE-ME` placeholder is left, so a half-configured app can't be deployed.
- `concurrency: deploy-dev` stops two deploys from running at the same time.
- Optional: add **required reviewers** to the `dev` environment (GitHub → Settings → Environments) so every deploy waits for a manual approval.

## One-time setup (owner, from a laptop with admin credentials)

1. **Bootstrap CDK** (once per account/region):
   ```bash
   cd infra && npm ci
   npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1
   ```
2. **Create the GitHub OIDC provider + deploy role:**
   ```bash
   npx cdk deploy Pmbok-GithubOidc -c githubOidc=true
   # If the account already has the GitHub OIDC provider (token.actions.githubusercontent.com):
   npx cdk deploy Pmbok-GithubOidc -c githubOidc=true -c createOidcProvider=false
   ```
   Copy the output `GithubDeployRoleArn`.
   This stack is **not** part of `--all`, so CI never changes its own role. To remove it later:
   `npx cdk destroy Pmbok-GithubOidc -c githubOidc=true`.
3. **GitHub → Settings → Environments → New environment `dev`.**
4. **GitHub → Settings → Secrets and variables → Actions → Variables.** None of these are secrets. You can set them at repo level or on the `dev` environment:

   | Variable | Required | Example |
   |---|---|---|
   | `AWS_DEPLOY_ROLE_ARN` | ✅ | `arn:aws:iam::123456789012:role/Pmbok-GithubOidc-GithubDeployRole...` |
   | `BEDROCK_MODEL_ID` | ✅ | inference profile id from `aws bedrock list-inference-profiles --region ap-northeast-1` |
   | `BUDGET_EMAIL` | ✅ | `you@example.com` |
   | `COGNITO_DOMAIN_PREFIX` | ✅ | `pmbok-assistant-<something-unique>` |
   | `AWS_REGION` | – | defaults to `ap-northeast-1` |
   | `QUERY_REWRITE_MODEL_ID` | – | cheaper model for the JA→EN search-query rewrite |
   | `OKTA_CONFIG` | – | `{"issuerUrl":"https://<org>.okta.com","clientId":"...","clientSecretName":"pmbok/okta-client-secret"}`. The secret value itself stays in Secrets Manager. |

   These values are written into `infra/cdk.json` **inside the CI runner only**. The committed `cdk.json` keeps its placeholders, so your email isn't in the repo.
5. Push to `main`, or run **Actions → Deploy → Run workflow**.

## Local deploys still work
For local deploys, set the values in `infra/cdk.json` (don't commit them) or pass them with `-c`. Then run `npx cdk deploy --all`. Local and CI deploys target the same stacks, so use one or the other.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Job not running in environment `dev`, repo name mismatch, or `AWS_DEPLOY_ROLE_ARN` wrong |
| `... is not authorized to perform: sts:AssumeRole on resource: cdk-hnb659fds-...` | CDK not bootstrapped in this region, or old bootstrap version without role tags → re-run `cdk bootstrap` |
| Synth error `Config still has placeholder values` | A required GitHub variable is missing |
| Smoke test: `/api/me` returned 403 | CloudFront OAC → Function URL permission problem (see deploy.md troubleshooting) |
| Smoke test: `/api/me` returned 5xx | Lambda error — check CloudWatch Logs for the api function |
