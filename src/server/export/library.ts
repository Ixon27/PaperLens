import ExcelJS from 'exceljs';
import { FIELD_LABELS, isFieldId } from '../../shared/fields';
import type { PaperRow, Author } from '../db';
import { HttpError } from '../http-error';

export const LIBRARY_COLUMNS = ['제목', '저자', '연도', '학술지', 'DOI', '분야', '추가일', '최근 열람일', 'PDF', '번역', '분석'] as const;
export type LibraryFormat = 'xlsx' | 'md';
export interface LibraryExportPaper {
  paper: PaperRow;
  authors: Author[];
  translation: { done: number; total: number };
  analysis: boolean;
}

export function parseLibraryExportRequest(body: unknown): { format: LibraryFormat; ids?: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '내보내기 요청이 올바르지 않습니다');
  const b = body as Record<string, unknown>;
  if (b.format !== 'xlsx' && b.format !== 'md') throw new HttpError(400, 'Excel 또는 Markdown 형식을 선택하세요');
  if (Object.keys(b).some((key) => key !== 'format' && key !== 'ids')) throw new HttpError(400, '알 수 없는 내보내기 옵션입니다');
  if ('ids' in b) {
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(b.ids).size !== b.ids.length) {
      throw new HttpError(400, '내보낼 논문 ID 목록이 올바르지 않습니다');
    }
    return { format: b.format, ids: b.ids as string[] };
  }
  return { format: b.format };
}

export function libraryCells({ paper: p, authors, translation: tr, analysis }: LibraryExportPaper): (string | number)[] {
  const translation = tr.total === 0 ? '번역 대상 없음' : tr.done === 0 ? `번역 전 (0/${tr.total})` : tr.done >= tr.total ? `번역 완료 (${tr.done}/${tr.total})` : `번역 중 (${tr.done}/${tr.total})`;
  return [p.title, authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; '), p.year ?? '', p.journal ?? '', p.doi ?? '',
    isFieldId(p.field) ? FIELD_LABELS[p.field] : '분야 확인 필요', p.created_at, p.last_opened_at ?? '열지 않음', p.pdf_file ? '있음' : '없음', translation, analysis ? '있음' : '없음'];
}

// Entities keep literal Markdown punctuation out of the table parser, including backslashes before pipes.
export function markdownCell(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/\*/g, '&#42;').replace(/_/g, '&#95;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/\r\n|\r|\n/g, '<br>');
}

export function libraryMarkdown(rows: LibraryExportPaper[]): string {
  const line = (cells: readonly (string | number)[]) => `| ${cells.map(markdownCell).join(' | ')} |`;
  return [line(LIBRARY_COLUMNS), line(LIBRARY_COLUMNS.map(() => '---')), ...rows.map((row) => line(libraryCells(row))), '',
    '최근 열람일은 마지막으로 연 시각이며 읽기 완료 여부가 아닙니다. 번역·분석 상태도 읽기 완료를 뜻하지 않습니다.', ''].join('\n');
}

export async function libraryXlsx(rows: LibraryExportPaper[]): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('논문 목록', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = LIBRARY_COLUMNS.map((header, i) => ({ header, width: [64, 32, 10, 32, 35, 24, 28, 28, 10, 24, 10][i] }));
  for (const row of rows) {
    // ExcelJS treats strings as literal shared strings, never as formula objects.
    sheet.addRow(libraryCells(row));
  }
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: LIBRARY_COLUMNS.length } };
  sheet.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  const notes = workbook.addWorksheet('안내');
  notes.getCell('A1').value = '최근 열람일은 마지막으로 연 시각이며 읽기 완료 여부가 아닙니다. 번역·분석 상태도 읽기 완료를 뜻하지 않습니다.';
  notes.getColumn(1).width = 100;
  notes.getCell('A1').alignment = { wrapText: true };
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
