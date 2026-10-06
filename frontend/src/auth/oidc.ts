import { UserManager, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';
import type { AppConfig } from '../config';

export function redirectUri(): string {
  return `${window.location.origin}/`;
}

export function buildOidcSettings(cfg: AppConfig): UserManagerSettings {
  return {
    authority: `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`,
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    post_logout_redirect_uri: redirectUri(),
    response_type: 'code', // PKCE is used automatically for the code flow
    scope: 'openid email profile',
    // Cognito issues refresh tokens for the code flow; oidc-client-ts renews with them before expiry.
    automaticSilentRenew: true,
    // Cognito has no userinfo-based claims we need beyond the ID token.
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  };
}

export function createUserManager(cfg: AppConfig): UserManager {
  return new UserManager(buildOidcSettings(cfg));
}

/**
 * Cognito doesn't implement the standard end_session_endpoint, so logout goes through
 * the managed login `/logout` endpoint. `logout_uri` must be in the app client's sign-out URLs.
 */
export function buildLogoutUrl(cfg: AppConfig, logoutUri: string = redirectUri()): string {
  const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: logoutUri });
  return `https://${cfg.cognitoDomain}/logout?${params.toString()}`;
}

export async function signOut(userManager: UserManager, cfg: AppConfig): Promise<void> {
  await userManager.removeUser();
  window.location.assign(buildLogoutUrl(cfg));
}

/** Strip `?code=...&state=...` from the URL after the sign-in callback has been processed. */
export function onSigninCallback(): void {
  window.history.replaceState({}, document.title, window.location.pathname);
}
