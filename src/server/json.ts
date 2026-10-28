/** Parse the first JSON object/array in an LLM response, tolerating fences and surrounding prose. */
export function parseJsonLoose<T>(text: string): T {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const iObj = stripped.indexOf('{');
  const iArr = stripped.indexOf('[');
  const start = iObj === -1 ? iArr : iArr === -1 ? iObj : Math.min(iObj, iArr);
  if (start !== -1) {
    const close = stripped[start] === '{' ? '}' : ']';
    const end = stripped.lastIndexOf(close);
    if (end > start) {
      const slice = stripped.slice(start, end + 1);
      try {
        return JSON.parse(slice) as T;
      } catch {
        try {
          return JSON.parse(slice.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, keep) => (keep ? m : '\\\\'))) as T;
        } catch {
          // fall through to the uniform error below
        }
      }
    }
  }
  throw new Error('JSON 파싱 실패: ' + text.slice(0, 200));
}
