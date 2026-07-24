/**
 * Read-only renderer for tiptap JSON documents (PRD §9.3, §8.3).
 * A tiny recursive React renderer — no editor instance needed.
 * Handles null / plain-string / malformed bodies gracefully.
 */
import type { ReactNode } from 'react';
import { cn } from '../ui';
import { useEntityRefClick } from './entityRefClick';
import './richtext.css';

/** True when the doc has no visible content (text, mentions, rules…). */
export function docIsEmpty(doc: unknown): boolean {
  if (!doc) return true;
  if (typeof doc === 'string') return doc.trim() === '';
  let has = false;
  const walk = (n: any): void => {
    if (!n || has || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string' && n.text.trim() !== '') {
      has = true;
      return;
    }
    if (n.type === 'mention' || n.type === 'entityMention' || n.type === 'horizontalRule' || n.type === 'image') {
      has = true;
      return;
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return !has;
}

function renderTextNode(node: any, key: string): ReactNode {
  let el: ReactNode = typeof node.text === 'string' ? node.text : '';
  const marks: any[] = Array.isArray(node.marks) ? node.marks : [];
  for (const mark of marks) {
    switch (mark?.type) {
      case 'bold':
        el = <strong>{el}</strong>;
        break;
      case 'italic':
        el = <em>{el}</em>;
        break;
      case 'strike':
        el = <s>{el}</s>;
        break;
      case 'code':
        el = <code>{el}</code>;
        break;
      case 'link': {
        const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '#';
        el = (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {el}
          </a>
        );
        break;
      }
      default:
        break;
    }
  }
  return <span key={key}>{el}</span>;
}

function renderChildren(content: unknown, keyPrefix: string): ReactNode {
  if (!Array.isArray(content)) return null;
  return content.map((child: any, i: number) => renderNode(child, `${keyPrefix}-${i}`));
}

function codeBlockText(node: any): string {
  if (!Array.isArray(node?.content)) return '';
  return node.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
}

function renderNode(node: any, key: string): ReactNode {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'text':
      return renderTextNode(node, key);
    case 'paragraph':
      return <p key={key}>{renderChildren(node.content, key)}</p>;
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2);
      const children = renderChildren(node.content, key);
      if (level <= 1) return <h1 key={key}>{children}</h1>;
      if (level === 2) return <h2 key={key}>{children}</h2>;
      return <h3 key={key}>{children}</h3>;
    }
    case 'bulletList':
      return <ul key={key}>{renderChildren(node.content, key)}</ul>;
    case 'orderedList':
      return <ol key={key}>{renderChildren(node.content, key)}</ol>;
    case 'listItem':
      return <li key={key}>{renderChildren(node.content, key)}</li>;
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {renderChildren(node.content, key)}
        </ul>
      );
    case 'taskItem': {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} data-checked={checked ? 'true' : 'false'}>
          <label>
            <input type="checkbox" checked={checked} disabled readOnly />
          </label>
          <div>{renderChildren(node.content, key)}</div>
        </li>
      );
    }
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{codeBlockText(node)}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node.content, key)}</blockquote>;
    case 'horizontalRule':
      return <hr key={key} />;
    case 'hardBreak':
      return <br key={key} />;
    case 'mention': {
      const label = node.attrs?.label ?? node.attrs?.id ?? '';
      return (
        <span key={key} data-type="mention" className="ordi-mention">
          @{String(label)}
        </span>
      );
    }
    case 'entityMention': {
      const label = node.attrs?.label ?? node.attrs?.id ?? '';
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
          {String(label)}
        </span>
      );
    }
    default:
      // Unknown block: render its children so content is never silently lost.
      if (Array.isArray(node.content)) return <span key={key}>{renderChildren(node.content, key)}</span>;
      return null;
  }
}

export function RichText({ doc, className }: { doc: unknown; className?: string }) {
  const onEntityClick = useEntityRefClick();
  if (docIsEmpty(doc)) return null;
  // Legacy/plain-string bodies: render as simple paragraphs.
  if (typeof doc === 'string') {
    return (
      <div className={cn('ordi-prose', className)}>
        {doc.split('\n').map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    );
  }
  const d = doc as { content?: unknown };
  return (
    <div className={cn('ordi-prose', className)} onClick={onEntityClick}>
      {renderChildren(d.content, 'n')}
    </div>
  );
}
