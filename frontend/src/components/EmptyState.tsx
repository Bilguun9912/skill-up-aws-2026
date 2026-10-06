import { useI18n } from '../i18n';

export function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <h2>{t.emptyTitle}</h2>
      <p className="muted">{t.emptySubtitle}</p>
      <div className="examples">
        {t.examples.map((q) => (
          <button key={q} type="button" className="example" onClick={() => onPick(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
