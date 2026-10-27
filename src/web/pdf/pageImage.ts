import type { PDFViewer } from 'pdfjs-dist/types/web/pdf_viewer';

/** Render even pages that have not yet been displayed by the viewer. */
export async function renderPageImage(viewer: PDFViewer, page: number, maxSide = 1600): Promise<string | null> {
  const doc = viewer.pdfDocument;
  if (!doc || page < 1 || page > doc.numPages) return null;
  const pdfPage = await doc.getPage(page);
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: Math.min(3, maxSide / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) return null;
  await pdfPage.render({ canvasContext, viewport }).promise;
  return canvas.toDataURL('image/png');
}
