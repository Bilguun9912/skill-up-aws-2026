import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation } from '../api/types';
import remarkCitations, { CITE_HREF_PREFIX } from '../lib/remarkCitations';
import { CitationChip } from './CitationChip';

interface Props {
  content: string;
  citations?: Citation[];
}

const remarkPlugins = [remarkGfm, remarkCitations];

function MarkdownImpl({ content, citations }: Props) {
  const components = useMemo<Components>(() => {
    const byN = new Map((citations ?? []).map((c) => [c.n, c]));
    return {
      a({ href, children, node: _node, ...rest }) {
        if (href?.startsWith(CITE_HREF_PREFIX)) {
          const n = Number(href.slice(CITE_HREF_PREFIX.length));
          return <CitationChip n={n} citation={byN.get(n)} />;
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {children}
          </a>
        );
      },
    };
  }, [citations]);

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
