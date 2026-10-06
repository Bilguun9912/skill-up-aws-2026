import { useEffect, useMemo, useRef, useState } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import type { UserManager } from 'oidc-client-ts';
import { ApiError, createApiClient } from './api/client';
import { createUserManager, onSigninCallback, signOut } from './auth/oidc';
import { loadConfig, type AppConfig } from './config';
import { ChatApp } from './components/ChatApp';
import { LoginScreen } from './components/LoginScreen';
import { useI18n } from './i18n';

const RELOGIN_KEY = 'pmbok.reloginAt';
const RELOGIN_COOLDOWN_MS = 60_000;

/** Load /config.json, then mount the OIDC provider. */
export function App() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig().then(setCfg, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  const userManager = useMemo(() => (cfg ? createUserManager(cfg) : null), [cfg]);

  if (error) {
    return (
      <div className="fullscreen">
        <p className="msg-error">
          {t.configError} {error}
        </p>
      </div>
    );
  }
  if (!cfg || !userManager) {
    return <div className="fullscreen muted">{t.loading}</div>;
  }
  return (
    <AuthProvider userManager={userManager} onSigninCallback={onSigninCallback}>
      <AuthGate cfg={cfg} userManager={userManager} />
    </AuthProvider>
  );
}

function AuthGate({ cfg, userManager }: { cfg: AppConfig; userManager: UserManager }) {
  const auth = useAuth();
  const { t, lang } = useI18n();
  const langRef = useRef(lang);
  langRef.current = lang;

  const api = useMemo(() => {
    /**
     * Re-login on 401 / unrecoverable expiry. Guarded so a misbehaving backend can't cause a
     * redirect loop: within the cooldown we just drop the user and show the login screen.
     */
    const relogin = () => {
      let recent = false;
      try {
        const at = Number(window.sessionStorage.getItem(RELOGIN_KEY) ?? 0);
        recent = Date.now() - at < RELOGIN_COOLDOWN_MS;
        window.sessionStorage.setItem(RELOGIN_KEY, String(Date.now()));
      } catch {
        // ignore storage errors
      }
      void userManager.removeUser().then(() => {
        if (!recent) void userManager.signinRedirect();
      });
    };

    return createApiClient({
      async getAccessToken() {
        let user = await userManager.getUser();
        if (!user || user.expired) {
          try {
            // Uses the refresh token (Cognito code flow) to get fresh tokens.
            user = await userManager.signinSilent();
          } catch {
            user = null;
          }
        }
        if (!user || user.expired) {
          relogin();
          throw new ApiError(401, 'unauthorized', 'Not signed in');
        }
        return user.access_token;
      },
      onUnauthorized: relogin,
      getUiLang: () => langRef.current,
    });
  }, [userManager]);

  // A stored-but-expired user (e.g. tab reopened later): try the refresh token once before
  // falling back to the login screen.
  const triedRenew = useRef(false);
  const expiredWithRefresh = !auth.isLoading && !!auth.user?.expired && !!auth.user.refresh_token;
  useEffect(() => {
    if (expiredWithRefresh && !triedRenew.current) {
      triedRenew.current = true;
      auth.signinSilent().catch(() => undefined);
    }
  }, [expiredWithRefresh, auth]);

  if (
    auth.isLoading ||
    auth.activeNavigator === 'signinRedirect' ||
    (expiredWithRefresh && auth.activeNavigator === 'signinSilent')
  ) {
    return <div className="fullscreen muted">{t.loading}</div>;
  }

  if (!auth.isAuthenticated) {
    return (
      <LoginScreen
        onSignIn={() => void auth.signinRedirect()}
        error={auth.error?.message}
      />
    );
  }

  const profile = auth.user?.profile;
  const userLabel =
    (typeof profile?.email === 'string' && profile.email) ||
    (typeof profile?.name === 'string' && profile.name) ||
    undefined;

  return (
    <ChatApp api={api} userLabel={userLabel} onSignOut={() => void signOut(userManager, cfg)} />
  );
}
