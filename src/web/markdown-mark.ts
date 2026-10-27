interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName: string };
}

/** Render Obsidian-style ==highlights== as marks without touching code or math. */
export function remarkMark() {
  return (tree: Node): void => {
    const visit = (node: Node): void => {
      if (!node.children || ['code', 'inlineCode', 'math', 'inlineMath'].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || child.value === undefined) {
          visit(child);
          return [child];
        }
        const value = child.value;
        const matches = [...value.matchAll(/==(?=\S)([^=\n]*?\S)==/g)];
        if (!matches.length) return [child];
        const result: Node[] = [];
        let from = 0;
        for (const match of matches) {
          if (match.index > from) result.push({ type: 'text', value: value.slice(from, match.index) });
          result.push({ type: 'mark', data: { hName: 'mark' }, children: [{ type: 'text', value: match[1] }] });
          from = match.index + match[0].length;
        }
        if (from < value.length) result.push({ type: 'text', value: value.slice(from) });
        return result;
      });
    };
    visit(tree);
  };
}
