import { describe, it, expect } from 'vitest';
import { markdownToDoc, markdownInline } from './markdown';

const doc = (md: string) => markdownToDoc(md).content as any[];

describe('markdownInline', () => {
  it('parses bold, italic, strike and code marks', () => {
    expect(markdownInline('a **b** *c* ~~d~~ `e`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'c', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'd', marks: [{ type: 'strike' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'e', marks: [{ type: 'code' }] },
    ]);
  });

  it('nests marks and keeps code spans literal', () => {
    expect(markdownInline('**bold _both_**')).toEqual([
      { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ]);
    expect(markdownInline('***both***')).toEqual([
      { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ]);
    expect(markdownInline('`**not bold**`')).toEqual([
      { type: 'text', text: '**not bold**', marks: [{ type: 'code' }] },
    ]);
  });

  it('keeps http links, drops unsafe schemes but keeps their text', () => {
    expect(markdownInline('[docs](https://example.com)')).toEqual([
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
    ]);
    expect(markdownInline('[boom](javascript:evil)')).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('turns images into links so the preview never fetches them', () => {
    expect(markdownInline('![logo](https://example.com/a.png)')).toEqual([
      { type: 'text', text: 'logo', marks: [{ type: 'link', attrs: { href: 'https://example.com/a.png' } }] },
    ]);
  });

  it('honours backslash escapes', () => {
    expect(markdownInline('\\*literal\\*')).toEqual([{ type: 'text', text: '*literal*' }]);
  });
});

describe('markdownToDoc', () => {
  it('parses headings, clamping deep levels to 3', () => {
    expect(doc('# One\n#### Deep')).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Deep' }] },
    ]);
  });

  it('splits paragraphs on blank lines, single newlines become hard breaks', () => {
    expect(doc('one\ntwo\n\nthree')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'two' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('parses fenced code with language, leaving markup inside untouched', () => {
    expect(doc('```ts\nconst a = **1**;\n```')).toEqual([
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = **1**;' }] },
    ]);
  });

  it('parses an unclosed fence to end of input', () => {
    expect(doc('```\nx')).toEqual([
      { type: 'codeBlock', attrs: { language: '' }, content: [{ type: 'text', text: 'x' }] },
    ]);
  });

  it('parses bullet and ordered lists with nesting', () => {
    expect(doc('- a\n- b\n  - b1\n1. c')).toEqual([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b1' }] }] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] },
        ],
      },
    ]);
  });

  it('parses task lists with checked state', () => {
    expect(doc('- [ ] todo\n- [x] done')).toEqual([
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] },
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
        ],
      },
    ]);
  });

  it('parses blockquotes recursively', () => {
    expect(doc('> quoted\n> # inside')).toEqual([
      {
        type: 'blockquote',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] },
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'inside' }] },
        ],
      },
    ]);
  });

  it('parses horizontal rules and does not confuse them with lists', () => {
    expect(doc('---')).toEqual([{ type: 'horizontalRule' }]);
    expect(doc('* * *')).toEqual([{ type: 'horizontalRule' }]);
  });

  it('parses pipe tables into header and cells', () => {
    expect(doc('| A | B |\n| --- | --- |\n| 1 | 2 |')).toEqual([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] },
            ],
          },
        ],
      },
    ]);
  });

  it('a table row with fewer cells than the header pads with empty cells', () => {
    const [table] = doc('| A | B |\n| - | - |\n| only |') as any[];
    const row = table.content[1];
    expect(row.content).toHaveLength(2);
    expect(row.content[1].content[0].content).toEqual([]);
  });

  it('a paragraph ends where a block construct starts', () => {
    expect(doc('text\n# head')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'text' }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'head' }] },
    ]);
  });

  it('normalises CRLF input', () => {
    expect(doc('# A\r\ntext')).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'text' }] },
    ]);
  });
});
