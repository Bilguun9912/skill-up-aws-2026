import type { Citation } from '../api/types';
import { citationLabel } from '../lib/citations';
import { useI18n } from '../i18n';

export function SourcesList({ citations }: { citations: Citation[] }) {
  const { t } = useI18n();
  if (citations.length === 0) return null;
  return (
    <details className="sources">
      <summary>{t.sources(citations.length)}</summary>
      <ol>
        {citations.map((c) => {
          const meta = citationLabel(c, t);
          return (
            <li key={c.n} value={c.n}>
              <div className="sources-head">
                <span className="sources-title">{c.title}</span>
                {meta && <span className="sources-meta">{meta}</span>}
              </div>
              <p className="sources-excerpt">{c.excerpt}</p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
