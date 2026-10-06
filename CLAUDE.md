# PMBOK Assistant (skill-up-aws-2026)

ChatGPT-style assistant that guides project managers using the PMBOK Guide (6th + 7th ed.), deployed serverless on AWS with CDK.
1-month POC, ~10 internal users, AWS credits only.

**Read before working:** `docs/architecture.md`, then the doc for your area:
- infra → `docs/decisions.md`, `docs/conventions.md` (CDK specifics), `docs/security.md`, `docs/cost.md`
- backend → `docs/api.md`, `docs/prompting.md`, `docs/conventions.md` (Backend specifics), `docs/security.md`
- frontend → `docs/api.md`, `docs/conventions.md` (Frontend specifics)
- status → `docs/tasks.md` · CI/CD → `docs/cicd.md`

## Hard rules
- Docs in `docs/` are the source of truth. If you must deviate, say so in your report (the coordinator updates docs).
- Never run `cdk deploy`, `cdk bootstrap`, `cdk destroy`, or mutating AWS CLI commands. `cdk synth`, tests, builds are fine.
- Never commit PMBOK PDFs or any secrets. Never log JWTs or prompt/response bodies.
- JWT goes in `x-auth-token` (not `Authorization`); POST bodies need `x-amz-content-sha256` (CloudFront OAC → Lambda URL).
- Packages are independent: `infra/`, `backend/`, `frontend/` each with own `package.json`. Run npm only inside your package.
- Don't commit or push unless asked.
