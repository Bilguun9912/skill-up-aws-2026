import { useI18n } from '../i18n';
import { LangToggle } from './LangToggle';

interface Props {
  onSignIn: () => void;
  /** Self sign-up domains (config.json); shows how to create an account. */
  signUpDomains?: string[];
  busy?: boolean;
  error?: string;
}

export function LoginScreen({ onSignIn, signUpDomains, busy, error }: Props) {
  const { t } = useI18n();
  return (
    <div className="login">
      <div className="login-lang">
        <LangToggle />
      </div>
      <div className="login-card">
        <div className="logo" aria-hidden="true">
          PM
        </div>
        <h1>{t.appName}</h1>
        <p className="muted">{t.tagline}</p>
        {error && (
          <p className="msg-error">
            {t.authError} {error}
          </p>
        )}
        <button type="button" className="btn btn-primary btn-lg" onClick={onSignIn} disabled={busy}>
          {busy ? t.signingIn : t.signIn}
        </button>
        {signUpDomains && signUpDomains.length > 0 && (
          <p className="muted login-hint">{t.signUpHint(signUpDomains.map((d) => `@${d}`).join(' / '))}</p>
        )}
      </div>
    </div>
  );
}
