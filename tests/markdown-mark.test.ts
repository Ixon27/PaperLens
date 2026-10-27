import { describe, expect, it } from 'vitest';
import { remarkMark } from '../src/web/markdown-mark';

describe('remarkMark', () => {
  it('renders marked text within a paragraph', () => {
    const paragraph = { type: 'paragraph', children: [{ type: 'text', value: 'a ==61%== b' }] };
    remarkMark()(paragraph);
    expect(paragraph.children).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'mark', data: { hName: 'mark' }, children: [{ type: 'text', value: '61%' }] },
      { type: 'text', value: ' b' },
    ]);
  });

  it('leaves code and math unchanged', () => {
    const tree = { type: 'root', children: [
      { type: 'inlineCode', value: '==x==' },
      { type: 'math', value: '==x==' },
    ] };
    remarkMark()(tree);
    expect(tree.children).toEqual([
      { type: 'inlineCode', value: '==x==' },
      { type: 'math', value: '==x==' },
    ]);
  });

  it('leaves invalid or unclosed markers as text', () => {
    const paragraph = { type: 'paragraph', children: [{ type: 'text', value: '== spaced == and a==b' }] };
    remarkMark()(paragraph);
    expect(paragraph.children).toEqual([{ type: 'text', value: '== spaced == and a==b' }]);
  });
});
