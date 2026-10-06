/** Runtime configuration written by the Pmbok-Frontend stack as /config.json (ADR-010). */
export interface AppConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Cognito managed login domain host, e.g. `my-prefix.auth.ap-northeast-1.amazoncognito.com`. */
  cognitoDomain: string;
}

const REQUIRED_KEYS: (keyof AppConfig)[] = ['region', 'userPoolId', 'clientId', 'cognitoDomain'];

export function parseConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    const value = obj[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`config.json is missing "${key}"`);
    }
  }
  return {
    region: (obj.region as string).trim(),
    userPoolId: (obj.userPoolId as string).trim(),
    clientId: (obj.clientId as string).trim(),
    // Accept either a bare host or a full URL; normalise to a bare host.
    cognitoDomain: (obj.cognitoDomain as string)
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
  };
}

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<AppConfig> {
  const res = await fetchImpl('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Could not load /config.json (HTTP ${res.status})`);
  }
  return parseConfig(await res.json());
}
