import { useMemo, useRef } from 'react';
import { createApiClient } from '../api/client';
import { ChatApp } from '../components/ChatApp';
import { useI18n } from '../i18n';

interface LocalToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Local dev only (docs/local-dev.md): no Cognito. Tokens come from the local api server's
 * `/local/token` endpoint and are only accepted by that server.
 */
export function LocalDevApp() {
  const { lang } = useI18n();
  const langRef = useRef(lang);
  langRef.current = lang;
  const tokenRef = useRef<LocalToken | null>(null);

  const api = useMemo(() => {
    const fetchToken = async (): Promise<LocalToken> => {
      const res = await fetch('/local/token', { cache: 'no-store' });
      if (!res.ok) throw new Error(`local token endpoint returned HTTP ${res.status}`);
      tokenRef.current = (await res.json()) as LocalToken;
      return tokenRef.current;
    };
    return createApiClient({
      async getAccessToken() {
        const t = tokenRef.current;
        if (t && t.expiresAt - Date.now() > 60_000) return t.accessToken;
        return (await fetchToken()).accessToken;
      },
      // The local server mints a new signing key on restart; just fetch a fresh token.
      onUnauthorized: () => {
        tokenRef.current = null;
      },
      getUiLang: () => langRef.current,
    });
  }, []);

  return <ChatApp api={api} userLabel="local-user (local dev)" onSignOut={() => window.location.reload()} />;
}
