import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { buildPmbokApp, BuildOptions, PmbokStacks } from '../lib/pmbok-app';

/** Context from cdk.json (defaults) — tests always start from the real defaults. */
export function cdkJsonContext(): Record<string, unknown> {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  return cdkJson.context;
}

export function makeApp(
  overrides: Record<string, unknown> = {},
  opts: BuildOptions = {},
): { app: App; stacks: PmbokStacks } {
  const app = new App({
    context: {
      ...cdkJsonContext(),
      account: '123456789012',
      apiCodeStub: true, // never bundle ../backend in unit tests
      ...overrides,
    },
  });
  const config = loadConfig(app.node);
  const stacks = buildPmbokApp(app, config, { siteAssetsDir: '/nonexistent-dist', ...opts });
  return { app, stacks };
}

export function contextSource(ctx: Record<string, unknown>) {
  return { tryGetContext: (k: string) => ctx[k] };
}
