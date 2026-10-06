#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { buildPmbokApp } from '../lib/pmbok-app';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';

const app = new App();
const config = loadConfig(app.node);
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
