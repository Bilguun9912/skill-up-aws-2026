# PMBOK Assistant (POC)

A ChatGPT-style assistant that helps project managers apply the **PMBOK Guide (6th & 7th ed.)** to their real situations.
Okta login · streaming chat · chat history · PMBOK citations. Serverless on AWS, deployed with CDK.

- Architecture: [docs/architecture.md](docs/architecture.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- API & data model: [docs/api.md](docs/api.md)
- Security: [docs/security.md](docs/security.md) · Cost: [docs/cost.md](docs/cost.md)
- Prompting: [docs/prompting.md](docs/prompting.md) · Conventions: [docs/conventions.md](docs/conventions.md)
- Tasks & status: [docs/tasks.md](docs/tasks.md) · CI/CD: [docs/cicd.md](docs/cicd.md) · Deploy: [docs/deploy.md](docs/deploy.md)

## Packages
| Dir | What |
|---|---|
| `infra/` | CDK app (TypeScript) |
| `backend/` | api Lambda (TypeScript, Node 22) |
| `frontend/` | React SPA (Vite) |
| `scripts/` | ops helpers (PMBOK upload + KB ingestion) |
