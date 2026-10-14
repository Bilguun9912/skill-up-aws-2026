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
- **The repo is public**, so lock down the `dev` environment (GitHub → Settings → Environments → dev):
  - *Deployment branches and tags* → **Selected branches: `main`** only.
  - *Required reviewers* → yourself, so every deploy waits for your approval (recommended).
- **IP allowlist:** the site is reachable only from company IPs (ADR-012). The GitHub runner is outside that network, so the smoke test checks that both `/` and `/api/me` return the allowlist 403. Run the full smoke test from the office or VPN (deploy.md §7).

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
4. **GitHub → Settings → Secrets and variables → Actions.** The repo is **public**, so Actions logs are readable by anyone, and step `env:` values are printed in them. Put anything private in **Secrets** (masked as `***`). Only harmless values go in **Variables**.

   | Name | Type | Required | Example |
   |---|---|---|---|
   | `AWS_DEPLOY_ROLE_ARN` | **Secret** (contains the account id) | ✅ | output `GithubDeployRoleArn` of `Pmbok-GithubOidc` |
   | `BUDGET_EMAIL` | **Secret** | ✅ | `you@example.com` |
   | `ALLOWED_IP_CIDRS` | **Secret** | ✅ | `198.51.100.10, 203.0.113.0/24`. **Never commit these** |
   | `ALLOWED_EMAIL_DOMAINS` | **Secret** | – | `example.co.jp` (self sign-up, ADR-014) |
   | `OKTA_CONFIG` | **Secret** | – | `{"issuerUrl":"https://<org>.okta.com","clientId":"...","clientSecretName":"pmbok/okta-client-secret"}` |
   | `BEDROCK_MODEL_ID` | Variable | ✅ | `jp.amazon.nova-2-lite-v1:0` |
   | `COGNITO_DOMAIN_PREFIX` | Variable | ✅ | `pmbok-assistant-<unique>` (public anyway: it's in the login URL) |
   | `QUERY_REWRITE_MODEL_ID` | Variable | – | defaults to `BEDROCK_MODEL_ID` |
   | `AWS_REGION` | Variable | – | defaults to `ap-northeast-1` |

   You can define them on the repo or on the `dev` environment (Settings → Environments → dev); the deploy job sees both.
   **Use the same values as your local `infra/cdk.local.json`**, especially `COGNITO_DOMAIN_PREFIX`, or local and CI deploys will fight.
   These values are written into `infra/cdk.json` **inside the CI runner only**. The committed `cdk.json` keeps its placeholders, so your email isn't in the repo.
5. Push to `main`, or run **Actions → Deploy → Run workflow**.

## Local deploys still work
Put your private values in **`infra/cdk.local.json`**. It's git-ignored; copy it from `infra/cdk.local.example.json`.
The app layers it over `cdk.json`. Don't use `~/.cdk.json` or `cdk.context.json` for this: CDK gives the committed
`cdk.json` precedence over both, so its placeholders would win.
Then run `npx cdk deploy --all -c strictConfig=true`. Without `allowedIpCidrs`, a local deploy would remove the IP restriction. Local and CI deploys target the same stacks, so keep both sets of values the same.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Job not running in environment `dev`, repo name mismatch, or `AWS_DEPLOY_ROLE_ARN` wrong |
| `... is not authorized to perform: sts:AssumeRole on resource: cdk-hnb659fds-...` | CDK not bootstrapped in this region, or old bootstrap version without role tags → re-run `cdk bootstrap` |
| Synth error `Config still has placeholder values` | A required GitHub variable is missing |
| Smoke test: `/api/me` returned 403 | CloudFront OAC → Function URL permission problem (see deploy.md troubleshooting) |
| Smoke test: `/api/me` returned 5xx | Lambda error — check CloudWatch Logs for the api function |
