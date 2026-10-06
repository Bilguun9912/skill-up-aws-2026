import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { makeApp } from './helpers';

/**
 * Exercises the real NodejsFunction (local esbuild) path against a tiny fake backend
 * package, so the bundling config is verified before ../backend exists.
 */
describe('api Lambda bundling (NodejsFunction)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmbok-backend-'));
    fs.mkdirSync(path.join(dir, 'src/handlers'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fake-backend', version: '0.0.0', type: 'module', private: true }),
    );
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'fake-backend', version: '0.0.0', lockfileVersion: 3, requires: true, packages: {} }),
    );
    // NodejsFunction runs `npx --no-install esbuild` in projectRoot → link infra's esbuild there.
    fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync(
      path.resolve(__dirname, '../node_modules/.bin/esbuild'),
      path.join(dir, 'node_modules/.bin/esbuild'),
    );
    fs.writeFileSync(
      path.join(dir, 'src/handlers/api.ts'),
      `declare const awslambda: any;
export const handler = awslambda.streamifyResponse(async (_e: unknown, s: { end(x: string): void }) => s.end('ok'));\n`,
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('fails synth with a helpful message when backend deps are not installed', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'pmbok-backend-bare-'));
    try {
      fs.mkdirSync(path.join(bare, 'src/handlers'), { recursive: true });
      fs.writeFileSync(path.join(bare, 'src/handlers/api.ts'), 'export const handler = 1;\n');
      fs.writeFileSync(path.join(bare, 'package-lock.json'), '{}');
      expect(() => makeApp({ apiCodeStub: false }, { backendDir: bare })).toThrow(/npm ci/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('bundles ../backend/src/handlers/api.ts as ESM with handler index.handler', () => {
    const { stacks } = makeApp({ apiCodeStub: false }, { backendDir: dir });
    const t = Template.fromStack(stacks.api);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Code: { S3Bucket: Match.anyValue(), S3Key: Match.stringLikeRegexp('\\.zip$') },
    });
    expect(Annotations.fromStack(stacks.api).findWarning('*', Match.stringLikeRegexp('STUB'))).toHaveLength(0);
  });
});
