/**
 * Read-only renderer for tiptap JSON documents (PRD §9.3, §8.3).
 * A recursive React renderer – no editor instance needed.
 *
 * This is the ONLY renderer: task bodies, comments, KB pages and previews all
 * come through here, so a block added to the editor is visible everywhere at
 * once. Handles null / plain-string / malformed bodies gracefully, and renders
 * an unknown node's children rather than dropping them, so a document written
 * by a newer build never loses text in an older one.
 */
import type { ReactNode } from 'react';
import { cn } from '../ui';
import { useEntityRefClick } from './entityRefClick';
import { lowlight } from './lowlight';
import { resolveFileSrc } from '../../lib/uploads';
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
    if (n.type === 'mention' || n.type === 'entityMention' || n.type === 'horizontalRule'
      || n.type === 'image' || n.type === 'table') {
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
      case 'underline':
        el = <u>{el}</u>;
        break;
      case 'strike':
        el = <s>{el}</s>;
        break;
      case 'code':
        el = <code>{el}</code>;
        break;
      case 'textStyle': {
        // The colour mark; other textStyle attributes are not offered by the
        // editor, so anything else here is safely ignored.
        const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : null;
        if (color) el = <span style={{ color }}>{el}</span>;
        break;
      }
      case 'highlight': {
        const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : undefined;
        el = <mark style={color ? { background: color } : undefined}>{el}</mark>;
        break;
      }
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

/* ── Syntax highlighting ─────────────────────────────────────────────────── */

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** hast (lowlight's output) → React, so read-only code matches the editor. */
function hastToReact(nodes: HastNode[] | undefined, keyPrefix: string): ReactNode {
  if (!nodes) return null;
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    if (n.type === 'text') return <span key={key}>{n.value ?? ''}</span>;
    if (n.type !== 'element') return null;
    const cls = n.properties?.className;
    const className = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : undefined;
    return <span key={key} className={className}>{hastToReact(n.children, key)}</span>;
  });
}

function renderCodeBlock(node: any, key: string): ReactNode {
  const text = codeBlockText(node);
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  // registered() guards against a document naming a grammar this build does not
  // bundle – lowlight throws rather than degrading on its own.
  if (language && lowlight.registered(language)) {
    try {
      const tree = lowlight.highlight(language, text) as unknown as HastNode;
      return (
        <pre key={key} data-language={language}>
          <code>{hastToReact(tree.children, key)}</code>
        </pre>
      );
    } catch { /* fall through to plain text */ }
  }
  return (
    <pre key={key} data-language={language || undefined}>
      <code>{text}</code>
    </pre>
  );
}

/* ── Nodes ───────────────────────────────────────────────────────────────── */

/** textAlign is stored as an attribute; the renderer turns it back into style. */
function alignStyle(node: any): { textAlign: 'center' | 'right' } | undefined {
  const align = node.attrs?.textAlign;
  return align === 'center' || align === 'right' ? { textAlign: align } : undefined;
}

function renderNode(node: any, key: string): ReactNode {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'text':
      return renderTextNode(node, key);
    case 'paragraph':
      return <p key={key} style={alignStyle(node)}>{renderChildren(node.content, key)}</p>;
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2);
      const children = renderChildren(node.content, key);
      const style = alignStyle(node);
      if (level <= 1) return <h1 key={key} style={style}>{children}</h1>;
      if (level === 2) return <h2 key={key} style={style}>{children}</h2>;
      return <h3 key={key} style={style}>{children}</h3>;
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
      return renderCodeBlock(node, key);
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node.content, key)}</blockquote>;
    case 'callout': {
      const tone = typeof node.attrs?.tone === 'string' ? node.attrs.tone : 'info';
      return <div key={key} data-callout="" data-tone={tone}>{renderChildren(node.content, key)}</div>;
    }
    case 'toggleBlock': {
      // Read-only toggles start in the state they were saved in. Collapsing is
      // still possible – the editor's NodeView handles the click there; here the
      // markup matches so the CSS is shared and the first block stays visible.
      const open = node.attrs?.open !== false;
      return (
        <div key={key} data-toggle="" data-open={open ? 'true' : 'false'}>
          <span data-toggle-chevron="" aria-hidden />
          <div data-toggle-body="">{renderChildren(node.content, key)}</div>
        </div>
      );
    }
    case 'table':
      return (
        <table key={key}>
          <tbody>{renderChildren(node.content, key)}</tbody>
        </table>
      );
    case 'tableRow':
      return <tr key={key}>{renderChildren(node.content, key)}</tr>;
    case 'tableHeader':
      return (
        <th key={key} colSpan={Number(node.attrs?.colspan ?? 1)} rowSpan={Number(node.attrs?.rowspan ?? 1)}>
          {renderChildren(node.content, key)}
        </th>
      );
    case 'tableCell':
      return (
        <td key={key} colSpan={Number(node.attrs?.colspan ?? 1)} rowSpan={Number(node.attrs?.rowspan ?? 1)}>
          {renderChildren(node.content, key)}
        </td>
      );
    case 'image': {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      if (!src) return null;
      return (
        <img
          key={key}
          // Stored paths are root-relative so the document survives a domain
          // change; the desktop origin cannot serve them as-is (lib/uploads).
          src={resolveFileSrc(src)}
          alt={typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''}
          title={typeof node.attrs?.title === 'string' ? node.attrs.title : undefined}
          loading="lazy"
        />
      );
    }
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
