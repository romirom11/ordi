/**
 * Lightweight read-only renderer for tiptap JSON docs (comments, previews).
 * Avoids mounting a full editor instance per comment; reuses .ordi-prose CSS.
 */
import type { ReactNode } from 'react';
import { cn } from '../ui';
import { useEntityRefClick } from '../richtext/entityRefClick';

interface Mark { type: string; attrs?: Record<string, unknown> }
interface Node {
  type: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: Node[];
}

function renderText(node: Node, key: number): ReactNode {
  let el: ReactNode = node.text ?? '';
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold': el = <strong>{el}</strong>; break;
      case 'italic': el = <em>{el}</em>; break;
      case 'strike': el = <s>{el}</s>; break;
      case 'code': el = <code>{el}</code>; break;
      case 'link':
        el = (
          <a href={String(mark.attrs?.href ?? '#')} target="_blank" rel="noreferrer noopener">
            {el}
          </a>
        );
        break;
      default: break;
    }
  }
  return <span key={key}>{el}</span>;
}

function renderNodes(nodes: Node[] | undefined): ReactNode {
  return (nodes ?? []).map((n, i) => renderNode(n, i));
}

function renderNode(node: Node, key: number): ReactNode {
  switch (node.type) {
    case 'text': return renderText(node, key);
    case 'paragraph': return <p key={key}>{renderNodes(node.content)}</p>;
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1';
      return <Tag key={key}>{renderNodes(node.content)}</Tag>;
    }
    case 'bulletList': return <ul key={key}>{renderNodes(node.content)}</ul>;
    case 'orderedList': return <ol key={key}>{renderNodes(node.content)}</ol>;
    case 'listItem': return <li key={key}>{renderNodes(node.content)}</li>;
    case 'taskList': return <ul key={key} data-type="taskList">{renderNodes(node.content)}</ul>;
    case 'taskItem':
      return (
        <li key={key} data-type="taskItem" data-checked={node.attrs?.checked ? 'true' : 'false'}>
          <label><input type="checkbox" checked={!!node.attrs?.checked} readOnly /></label>
          <div>{renderNodes(node.content)}</div>
        </li>
      );
    case 'blockquote': return <blockquote key={key}>{renderNodes(node.content)}</blockquote>;
    case 'codeBlock': return <pre key={key}><code>{renderNodes(node.content)}</code></pre>;
    case 'horizontalRule': return <hr key={key} />;
    case 'hardBreak': return <br key={key} />;
    case 'mention':
      return <span key={key} className="ordi-mention">@{String(node.attrs?.label ?? node.attrs?.id ?? '')}</span>;
    case 'entityMention':
      return (
        <span
          key={key}
          data-type="entity-mention"
          data-kind={typeof node.attrs?.kind === 'string' ? node.attrs.kind : undefined}
          data-url={typeof node.attrs?.url === 'string' ? node.attrs.url : undefined}
          className="ordi-ref"
          role="link"
          tabIndex={0}
        >
          {String(node.attrs?.label ?? node.attrs?.id ?? '')}
        </span>
      );
    default: return <span key={key}>{renderNodes(node.content)}</span>;
  }
}

export function RichBody({ doc, className }: { doc: unknown; className?: string }) {
  const onEntityClick = useEntityRefClick();
  const root = doc as Node | null;
  if (!root || root.type !== 'doc') return null;
  return (
    <div className={cn('ordi-prose', className)} onClick={onEntityClick}>
      {renderNodes(root.content)}
    </div>
  );
}
