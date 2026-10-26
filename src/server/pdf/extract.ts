import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN, POPPLER_MISSING } from '../config';

const execFileP = promisify(execFile);

export type LineBox = [number, number, number, number];

export interface Block {
  idx: number;
  page: number;
  text: string;
  /** [xMin, yMin, xMax, yMax] in PDF points, top-left origin. */
  lines: LineBox[];
  pageW: number;
  pageH: number;
  isRef: boolean;
}

const TOKEN_RE =
  /<page width="([\d.]+)" height="([\d.]+)">|<\/page>|<block\b[^>]*>|<\/block>|<line xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">|<\/line>|<word\b[^>]*>([\s\S]*?)<\/word>/g;

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Join a block's lines, repairing words hyphenated across line breaks. */
export function joinLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!line) continue;
    if (!out) out = line;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else if (out.endsWith('-')) out += line;
    else out += ' ' + line;
  }
  return out;
}

const REF_HEADING = /^\s*(\d+\.?\s*)?(references( and notes)?|literature cited|bibliography|참고문헌)\s*$/i;
const REF_END = /^\s*(supplementary|appendix|acknowledg|figure legends)/i;

/** Mark blocks after the last references heading until the first back-matter heading. */
export function markReferences(blocks: Block[]): void {
  let start = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (REF_HEADING.test(blocks[i].text)) {
      start = i;
      break;
    }
  }
  if (start === -1) return;
  for (let i = start + 1; i < blocks.length; i++) {
    if (REF_END.test(blocks[i].text)) break;
    blocks[i].isRef = true;
  }
}

/** Parse `pdftotext -bbox-layout` XHTML into paragraph blocks in reading order. */
export function parseBboxLayout(xhtml: string): { pageCount: number; blocks: Block[] } {
  const blocks: Block[] = [];
  let page = 0;
  let pageW = 0;
  let pageH = 0;
  let lineTexts: string[] = [];
  let lineBoxes: LineBox[] = [];
  let words: string[] = [];
  let box: LineBox | null = null;

  for (const m of xhtml.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (m[1] !== undefined) {
      page++;
      pageW = parseFloat(m[1]);
      pageH = parseFloat(m[2]);
    } else if (tok.startsWith('<block')) {
      lineTexts = [];
      lineBoxes = [];
    } else if (tok === '</block>') {
      const text = joinLines(lineTexts).trim();
      if (text) blocks.push({ idx: blocks.length, page, text, lines: lineBoxes, pageW, pageH, isRef: false });
    } else if (m[3] !== undefined) {
      words = [];
      box = [parseFloat(m[3]), parseFloat(m[4]), parseFloat(m[5]), parseFloat(m[6])];
    } else if (tok === '</line>') {
      const text = words.join(' ').trim();
      if (text && box) {
        lineTexts.push(text);
        lineBoxes.push(box);
      }
      box = null;
    } else if (m[7] !== undefined) {
      words.push(decode(m[7]));
    }
  }
  markReferences(blocks);
  return { pageCount: page, blocks };
}

export async function extractBlocks(pdfPath: string): Promise<{ pageCount: number; blocks: Block[] }> {
  if (!BIN.pdftotext) throw new Error(POPPLER_MISSING);
  const { stdout } = await execFileP(BIN.pdftotext, ['-bbox-layout', pdfPath, '-'], { maxBuffer: 256 << 20 });
  return parseBboxLayout(stdout);
}
