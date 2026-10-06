import { useI18n, type Lang } from '../i18n';

const LANGS: { id: Lang; label: string }[] = [
  { id: 'ja', label: 'JA' },
  { id: 'en', label: 'EN' },
];

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-toggle" role="group" aria-label={t.language}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          aria-pressed={lang === l.id}
          className={lang === l.id ? 'on' : undefined}
          onClick={() => setLang(l.id)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
