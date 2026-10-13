# Local development

Run the whole app on your laptop: the same React app and the same backend handler as production. Docker is required.

```bash
./scripts/dev-local.sh            # fake Bedrock — no AWS account or credentials needed
open http://localhost:5173        # you are signed in automatically as "local-user"
```

| Production | Local replacement |
|---|---|
| Okta → Cognito sign-in | None. The local api server mints tokens (`GET /local/token`) with a key generated at startup and preloads that key into the real `aws-jwt-verify` verifier, so the production auth code path still runs. |
| CloudFront → Lambda Function URL | `backend/local/server.ts` turns HTTP requests into Function URL events and calls the real `handle()` from `src/handlers/api.ts` on `:3001`. |
| DynamoDB | DynamoDB Local in Docker (`docker-compose.local.yml`, port 8000). Data persists in a Docker volume. The table `PmbokLocal` is created automatically. |
| Bedrock KB `Retrieve` | `--fake`: 3 sample chunks (placeholder text, not PMBOK quotes). `--real`: your KB if `KNOWLEDGE_BASE_ID` is set, otherwise the samples. |
| Bedrock `ConverseStream` | `--fake`: a canned Japanese or English answer, streamed in small pieces. `--real`: the real model (`MODEL_ID`). |
| SSM (client id) | Mocked. |

The Vite dev server (`npm run dev:local` in `frontend/`) proxies `/api`, `/local` and `/config.json` to `:3001`.
The local `/config.json` carries `localDev: true`, which makes the SPA skip OIDC. Production builds compile this
branch out (`import.meta.env.DEV`). CI also checks that `local/token` doesn't appear in `dist/`.

## Modes

### Fake (default) — UI and flow testing, free, offline
Covers sessions, history, streaming, citations, Japanese/English, the Japanese-question search rewrite (faked), quotas and errors.

### Real Bedrock — test answer quality
Uses your local AWS credentials (`aws configure` / `aws sso login`). Behind the company TLS proxy, also set `AWS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`.

```bash
MODEL_ID=<inference-profile-id> ./scripts/dev-local.sh --real
# with the deployed knowledge base (after the first deploy + upload-pmbok.sh):
MODEL_ID=<id> KNOWLEDGE_BASE_ID=<KnowledgeBaseId output> ./scripts/dev-local.sh --real
# optional: QUERY_REWRITE_MODEL_ID=<cheaper model> MODEL_EFFORT=low
```
This calls Bedrock for real, so each question costs money, the same as production.

## Running the pieces separately
```bash
docker compose -f docker-compose.local.yml up -d
(cd backend  && BEDROCK_MODE=fake npm run dev:local)   # :3001
(cd frontend && npm run dev:local)                      # :5173
```
Env options for the local api: `BEDROCK_MODE`, `PORT` (3001), `DYNAMODB_ENDPOINT` (http://localhost:8000), `TABLE_NAME` (PmbokLocal), `DAILY_QUESTION_LIMIT` (1000), plus `MODEL_ID` / `KNOWLEDGE_BASE_ID` / `QUERY_REWRITE_MODEL_ID` / `MODEL_EFFORT` in real mode.

To test the quota, run with `DAILY_QUESTION_LIMIT=2`. Usage is stored per day, so to start over:
`docker compose -f docker-compose.local.yml down -v` (this wipes local data).

## Other ways to test
- Unit tests (no AWS): `npm test` in `backend/`, `frontend/`, `infra/`.
- Local frontend + **deployed** backend: see `frontend/README.md` (`VITE_API_PROXY_TARGET`).

## Limits of local mode
CloudFront/OAC header signing, Cognito/Okta sign-in, IAM permissions and Lambda streaming quirks are **not** exercised locally.
The deploy smoke test and `docs/deploy.md` §7 cover those.
