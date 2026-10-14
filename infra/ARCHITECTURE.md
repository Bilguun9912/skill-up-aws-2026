# Infrastructure Architecture

AWS infrastructure for the PMBOK Assistant POC, as defined by this CDK app (`ap-northeast-1`).
Design rationale lives in [`../docs/decisions.md`](../docs/decisions.md). The overall system view is in [`../docs/architecture.md`](../docs/architecture.md).

> Public repo: this file contains no account IDs, IPs or emails. Those come from `cdk.local.json` / GitHub variables.

## 1. Resources by stack

```mermaid
flowchart LR
  user(["User browser<br/>(company network / VPN)"])
  okta(["Okta<br/>(company IdP)"])
  gh(["GitHub Actions"])

  subgraph FE["Pmbok-Frontend"]
    cf["CloudFront distribution<br/>IPv6 off while allowlist is on"]
    fnSite["CloudFront Function<br/>IP allowlist + SPA routing"]
    fnApi["CloudFront Function<br/>IP allowlist"]
    site[("S3 site bucket<br/>SPA + config.json")]
    client["Cognito app client<br/>(public, PKCE)"]
    ssm["SSM parameter<br/>/pmbok/&lt;stage&gt;/cognito/client-id"]
  end

  subgraph AUTH["Pmbok-Auth"]
    pool["Cognito user pool<br/>self sign-up off"]
    domain["Managed login domain"]
    idp["OIDC IdP: Okta<br/>(when configured)"]
    secret[("Secrets Manager<br/>Okta client secret")]
  end

  subgraph API["Pmbok-Api"]
    url["Lambda Function URL<br/>AWS_IAM · RESPONSE_STREAM"]
    fn["api Lambda<br/>Node 22 · arm64 · 512 MB"]
    logs["CloudWatch Logs<br/>30-day retention"]
  end

  subgraph DATA["Pmbok-Data"]
    ddb[("DynamoDB table<br/>sessions · messages · usage")]
    docs[("S3 docs bucket<br/>pmbok/*.pdf + metadata")]
  end

  subgraph KB["Pmbok-Knowledge"]
    kb["Bedrock Knowledge Base"]
    ds["S3 data source<br/>fixed 512-token chunks"]
    vec[("S3 Vectors<br/>bucket + index, 1024-d cosine")]
  end

  subgraph BR["Amazon Bedrock (models)"]
    llm["Nova 2 Lite<br/>jp. inference profile"]
    emb["Titan Text Embeddings v2"]
  end

  subgraph OPS["Pmbok-Ops"]
    budget["AWS Budget<br/>email alerts"]
  end

  subgraph CICD["Pmbok-GithubOidc (one-time, optional)"]
    oidc["GitHub OIDC provider<br/>+ deploy role"]
  end

  user -->|HTTPS| cf
  cf --- fnSite
  cf --- fnApi
  cf -->|"/* · OAC"| site
  cf -->|"/api/* · OAC SigV4"| url
  url --> fn
  fn --> logs

  user -.->|sign in| domain
  domain --- pool
  pool --- idp
  idp -.->|OIDC| okta
  idp -.- secret
  client --- pool

  fn -->|"verify JWT (client id from SSM)"| ssm
  fn -->|read/write| ddb
  fn -->|Retrieve| kb
  fn -->|ConverseStream| llm

  kb --- vec
  kb --- ds
  ds -->|ingest| docs
  kb -->|embed| emb

  gh -.->|"AssumeRoleWithWebIdentity"| oidc
```

## 2. Chat request flow

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (SPA)
  participant CF as CloudFront
  participant L as api Lambda
  participant D as DynamoDB
  participant K as Bedrock KB (S3 Vectors)
  participant M as Nova 2 Lite

  B->>CF: POST /api/chat<br/>x-auth-token, x-amz-content-sha256
  CF->>CF: CloudFront Function: IP allowlist (403 if outside)
  CF->>L: OAC-signed request (Function URL, AWS_IAM)
  L->>L: verify Cognito access token
  L->>D: increment daily quota (429 if over)
  L->>D: load last N messages
  opt question is Japanese
    L->>M: Converse: rewrite as English search query
  end
  L->>K: Retrieve top-k chunks (source = pmbok)
  K-->>L: chunks + edition / page metadata
  L-->>B: NDJSON: session, citations
  L->>M: ConverseStream (system prompt + sources + history)
  loop streaming
    M-->>L: text delta
    L-->>B: NDJSON: delta
  end
  L->>D: save user + assistant messages (one transaction)
  L-->>B: NDJSON: done (token usage)
```

## 3. Stack dependencies

```mermaid
flowchart LR
  ops["Pmbok-Ops"]
  auth["Pmbok-Auth"]
  data["Pmbok-Data"]
  kb["Pmbok-Knowledge"]
  api["Pmbok-Api"]
  fe["Pmbok-Frontend"]
  data --> kb --> api --> fe
  auth --> api
  auth --> fe
```

Cross-stack references are weak (`Fn::GetStackOutput`, no exports), so always deploy and destroy with `--all`.
The Cognito app client lives in **Pmbok-Frontend** because its callback URL needs the CloudFront domain. The Lambda
reads the client id from SSM at runtime, which avoids a dependency cycle (ADR-006).
`Pmbok-GithubOidc` is only synthesized with `-c githubOidc=true` and is never part of `--all`.

## 4. Security boundaries

| Layer | Control |
|---|---|
| Network edge | CloudFront Functions allow only company egress IPs (`allowedIpCidrs`) on both `/*` and `/api/*`. IPv6 is disabled while the allowlist is active (ADR-012) |
| Origin access | S3 site bucket and Lambda Function URL accept **only** CloudFront OAC-signed requests. Function URL auth is `AWS_IAM` |
| Identity | Cognito (federated with Okta). The Lambda verifies access tokens on every request (`x-auth-token`) |
| Data isolation | Every DynamoDB key includes the caller's verified `sub` |
| Cost | Per-user daily question limit, `maxTokens` cap, AWS Budget email alerts |
| Least privilege | Lambda: one table, one KB, one SSM parameter, the configured model profiles only. CI role: may only assume the CDK bootstrap roles |
| No VPC | Nothing listens on a network we own; all services are IAM-authenticated over TLS (ADR-001) |

## 5. Where config comes from

| Value | Local deploy | GitHub Actions |
|---|---|---|
| Model id, budget email, Cognito domain prefix, allowed IPs, Okta | `infra/cdk.local.json` (git-ignored) | GitHub variables (`docs/cicd.md`) |
| Everything else | `infra/cdk.json` (committed defaults) | same |

Deploy with `npx cdk deploy --all -c strictConfig=true`. Strict mode refuses placeholders and an empty IP allowlist.
