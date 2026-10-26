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
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as T;
      } catch {
        // fall through to the uniform error below
      }
    }
  }
  throw new Error('JSON 파싱 실패: ' + text.slice(0, 200));
}
