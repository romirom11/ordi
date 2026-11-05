/**
 * A read-only highlighted code snippet outside the editor (an embed code, a
 * config line), coloured by the same lowlight grammars and token palette as
 * code blocks in tasks and pages.
 */
import { useMemo, type ReactNode } from 'react';
import { lowlight } from './lowlight';
import { cn } from '../ui';
import './richtext.css';

/** The slice of a hast tree lowlight produces: elements with classes, and text. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
}

function render(nodes: HastNode[] | undefined): ReactNode[] {
  return (nodes ?? []).map((node, index) => {
    if (node.type === 'text') return node.value ?? '';
    if (node.type !== 'element') return null;
    const cls = node.properties?.className;
    return (
      <span key={index} className={Array.isArray(cls) ? cls.join(' ') : cls}>
        {render(node.children)}
      </span>
    );
  });
}

export function CodeSnippet({ code, language, className }: { code: string; language: string; className?: string }) {
  const tree = useMemo(() => {
    try {
      return lowlight.highlight(language, code) as unknown as HastNode;
    } catch {
      return null; // unregistered language: plain text
    }
  }, [code, language]);

  return (
    <div className="ordi-prose">
      <pre className={cn('!m-0', className)}>
        <code className={`hljs language-${language}`}>{tree ? render(tree.children) : code}</code>
      </pre>
    </div>
  );
}
