import katex from 'katex';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { describe, expect, it } from 'vitest';
import { KATEX_OPTIONS } from '../src/web/katex-options';

describe('field math rendering', () => {
  it.each(['\\ce{H2O}', '\\argmin_x f(x)', '\\pdv{f}{x}', '\\ket{\\psi}'])('renders %s', (src) => {
    const html = katex.renderToString(src, { ...KATEX_OPTIONS, throwOnError: true });
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it('renders chemistry through the Markdown plugin', () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkMath],
      rehypePlugins: [[rehypeKatex, KATEX_OPTIONS]],
      children: '$\\ce{H2O}$',
    }));
    expect(html).toContain('<msub>');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('color:#cc0000');
  });
});
