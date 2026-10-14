#!/usr/bin/env node
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { LOCAL_CONTEXT_FILE, loadConfig, readLocalContext, withLocalOverrides } from '../lib/config';
import { buildPmbokApp } from '../lib/pmbok-app';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';

const app = new App();
// Private per-developer values (model id, email, company IPs) live in git-ignored infra/cdk.local.json.
const localContext = readLocalContext(path.join(__dirname, '..', LOCAL_CONTEXT_FILE));
const config = loadConfig(withLocalOverrides(app.node, localContext));
buildPmbokApp(app, config);

// One-time CI/CD bootstrap stack. Only added with `-c githubOidc=true` so that
// `cdk deploy --all` (including from CI) never touches the CI role itself.
if (String(app.node.tryGetContext('githubOidc')) === 'true') {
  new GithubOidcStack(app, 'Pmbok-GithubOidc', {
    env: { account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
    description: 'PMBOK Assistant: GitHub Actions OIDC deploy role',
    githubRepo: app.node.tryGetContext('githubRepo') ?? 'Bilguun9912/skill-up-aws-2026',
    githubEnvironment: app.node.tryGetContext('githubEnvironment') ?? 'dev',
    createOidcProvider: String(app.node.tryGetContext('createOidcProvider') ?? 'true') === 'true',
  });
}

app.synth();
