# PMBOK Assistant — frontend

Vite + React + TypeScript SPA. Signs in with Cognito (OIDC code flow + PKCE via
`oidc-client-ts` / `react-oidc-context`) and talks to `/api/*` (see `../docs/api.md`).
UI is bilingual (Japanese / English).

## Scripts

```bash
npm install
npm run dev        # Vite dev server on http://localhost:5173
npm test           # vitest (no network)
npx tsc --noEmit   # typecheck
npm run build      # typecheck + production build → dist/ (deployed by the Pmbok-Frontend CDK stack)
```

## Local development

1. **Runtime config.** The app loads `/config.json` at startup (ADR-010). In production the
   CDK stack writes it; locally create it from the example (the real file is git-ignored and is
   removed from `dist/` on build):

   ```bash
   cp public/config.example.json public/config.json
   ```

   Fill in the values from the deployed stacks' outputs:

   ```json
   {
     "region": "ap-northeast-1",
     "userPoolId": "ap-northeast-1_XXXXXXXXX",
     "clientId": "<user pool app client id>",
     "cognitoDomain": "<prefix>.auth.ap-northeast-1.amazoncognito.com"
   }
   ```

   `cognitoDomain` is the managed-login host (no `https://`).

2. **API proxy.** Point the dev server at the deployed CloudFront distribution so `/api/*`
   goes through CloudFront → Lambda (OAC):

   ```bash
   echo 'VITE_API_PROXY_TARGET=https://dxxxxxxxxxxxxx.cloudfront.net' > .env.local
   npm run dev
   ```

3. **Cognito callback URLs.** `http://localhost:5173/` must be in the app client's callback and
   sign-out URLs (`localDevOrigins` in the infra config). The dev server uses a strict port of 5173.

## How it works

- **Auth:** authority `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`,
  `redirect_uri = <origin>/`, scope `openid email profile`. Tokens are kept in `sessionStorage`
  and renewed with the refresh token before expiry; on an unrecoverable expiry or an API 401 the
  user is sent back to sign-in. Sign-out clears the local user and redirects to Cognito's
  `https://<cognitoDomain>/logout?client_id=…&logout_uri=<origin>/`.
- **API client** (`src/api/client.ts`): every request sends `x-auth-token: <access token>` and
  `x-ui-lang: ja|en`; requests with a body also send `content-type: application/json` and
  `x-amz-content-sha256` (hex SHA-256 of the exact body string) for CloudFront OAC.
- **Streaming chat:** `POST /api/chat` is read as NDJSON (`src/api/ndjson.ts`) and rendered
  incrementally; the Stop button aborts the request.
- **Citations:** `[n]` markers in answers become chips (`src/lib/remarkCitations.ts`) that open
  the source (edition, title, page, excerpt); each answer lists its sources.
- **i18n:** strings live in `src/i18n/{en,ja}.ts`. Default from `navigator.language`, toggle in the
  header (stored in `localStorage`). Enter-to-send is suppressed during IME composition.
