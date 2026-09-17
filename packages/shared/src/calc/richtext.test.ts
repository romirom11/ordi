import { describe, it, expect } from 'vitest';
import { docToText, textToDoc } from './richtext';

describe('textToDoc mentions', () => {
  const roman = { id: 'u1', label: 'Roman Kudin' };
  const rom = { id: 'u2', label: 'Roman' };

  it('turns @Name in the text into a mention node, longest label first', () => {
    const doc = textToDoc('@Roman Kudin done, ping @Roman too', { mentions: [rom, roman] });
    const para = (doc.content as any[])[0];
    expect(para.content).toEqual([
      { type: 'mention', attrs: { id: 'u1', label: 'Roman Kudin' } },
      { type: 'text', text: ' done, ping ' },
      { type: 'mention', attrs: { id: 'u2', label: 'Roman' } },
      { type: 'text', text: ' too' },
    ]);
    expect(docToText(doc)).toBe('@Roman Kudin done, ping @Roman too');
  });

  it('puts a mentioned person the text never names at the start', () => {
    const doc = textToDoc('Done.\n\nSecond paragraph.', { mentions: [roman] });
    expect(docToText(doc)).toBe('@Roman Kudin Done.\n\nSecond paragraph.');
    const [first] = doc.content as any[];
    expect(first.content[0]).toEqual({ type: 'mention', attrs: { id: 'u1', label: 'Roman Kudin' } });
  });

  it('leaves a plain @ and a longer word alone', () => {
    const doc = textToDoc('mail@Roman.example and @Romanov', { mentions: [rom] });
    // Neither the address nor "@Romanov" names Roman, so the mention is put at the start.
    expect((doc.content as any[])[0].content.filter((n: any) => n.type === 'mention')).toHaveLength(1);
    expect(docToText(doc)).toBe('@Roman mail@Roman.example and @Romanov');
  });

  it('without mentions the doc is unchanged', () => {
    expect(textToDoc('a\nb\n\nc')).toEqual({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
    ] });
  });
});
