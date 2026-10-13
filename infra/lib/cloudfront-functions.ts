/**
 * CloudFront Functions (viewer-request, JS 2.0 runtime) for the distribution.
 *
 * - IP allowlist: only company egress IPs may reach the site and /api (config.allowedIpCidrs).
 *   Cheaper than WAF (no us-east-1 stack, no $5/mo ACL) and enough for ~10 internal users.
 * - SPA routing (default behavior only): extension-less paths → /index.html. Done here instead
 *   of distribution error responses so API 4xx/5xx from /api/* are never masked.
 *
 * Code is generated as plain ES5-ish JS so tests can evaluate it in Node (test/cloudfront-functions.test.ts).
 */

/** Header on the 403 so the CI smoke test can tell "blocked by allowlist" from an OAC 403. */
export const BLOCKED_HEADER = 'x-pmbok-blocked';

function cidrToRange(cidr: string): [number, number] {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const o = ip!.split('.').map(Number);
  const addr = ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(addr & mask) >>> 0, mask];
}

export interface ViewerRequestOptions {
  /** Normalised IPv4 CIDRs; empty → no IP check. */
  allowedIpCidrs: string[];
  /** Apply SPA routing (default S3 behavior only). */
  spaRewrite: boolean;
}

export function buildViewerRequestCode(opts: ViewerRequestOptions): string {
  const ranges = opts.allowedIpCidrs.map(cidrToRange);
  const lines: string[] = [];
  if (ranges.length > 0) {
    lines.push(
      `var ALLOWED = ${JSON.stringify(ranges)};`,
      `function ipAllowed(ip) {`,
      `  var p = (ip || '').split('.');`,
      `  if (p.length !== 4) { return false; }`, // IPv6 or garbage → deny
      `  var n = 0;`,
      `  for (var i = 0; i < 4; i++) {`,
      `    var o = parseInt(p[i], 10);`,
      `    if (isNaN(o) || o < 0 || o > 255) { return false; }`,
      `    n = ((n << 8) | o) >>> 0;`,
      `  }`,
      `  for (var j = 0; j < ALLOWED.length; j++) {`,
      `    if (((n & ALLOWED[j][1]) >>> 0) === ALLOWED[j][0]) { return true; }`,
      `  }`,
      `  return false;`,
      `}`,
    );
  }
  lines.push(`function handler(event) {`, `  var req = event.request;`);
  if (ranges.length > 0) {
    lines.push(
      `  if (!ipAllowed(event.viewer && event.viewer.ip)) {`,
      `    return {`,
      `      statusCode: 403,`,
      `      statusDescription: 'Forbidden',`,
      `      headers: {`,
      `        'content-type': { value: 'text/plain; charset=utf-8' },`,
      `        'cache-control': { value: 'no-store' },`,
      `        '${BLOCKED_HEADER}': { value: 'ip' }`,
      `      },`,
      `      body: 'Access is restricted to the company network (office / VPN).\\n社内ネットワーク（本社・VPN）からのみアクセスできます。\\n'`,
      `    };`,
      `  }`,
    );
  }
  if (opts.spaRewrite) {
    lines.push(
      `  var uri = req.uri;`,
      `  if (uri.indexOf('/api/') !== 0 && uri !== '/api') {`,
      `    var last = uri.substring(uri.lastIndexOf('/') + 1);`,
      `    if (last.indexOf('.') === -1) { req.uri = '/index.html'; }`,
      `  }`,
    );
  }
  lines.push(`  return req;`, `}`);
  return lines.join('\n') + '\n';
}
