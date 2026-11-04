import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { LayoutTranslationDocument, LayoutTranslationPage } from '../../shared/layout-translation';
import { api } from '../api';
import { AiUsageNotice } from '../components/AiUsageNotice';
import { chipCls, inputCls, primaryBtnCls, smallBtnCls } from '../components/Dialog';
import { isCancelled, JobBar, Spinner } from '../components/JobBar';
import { ModelBadge } from '../components/ModelBadge';
import { exportLayoutPdf, renderLayoutPage, type LayoutPlacement, type LayoutRenderResult } from '../pdf/layoutRenderer';
import { usePaper } from '../state/paper';
import { useJob } from '../state/useJob';

GlobalWorkerOptions.workerSrc = workerUrl;

type Source = { pdf: PDFDocumentProxy; hash: string };
type PageRender = { page: number; original: HTMLCanvasElement; translated?: LayoutRenderResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only the requested page is rasterized; large/oversized PDFs cannot allocate unbounded canvases. */
async function renderOriginal(pdf: PDFDocumentProxy, pageNumber: number, maxSide: number, signal: AbortSignal): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  const page = await pdf.getPage(pageNumber);
  signal.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  if (!(base.width > 0 && base.height > 0 && Number.isFinite(base.width) && Number.isFinite(base.height))) {
    throw new Error('PDF 페이지 크기를 읽을 수 없습니다.');
  }
  const viewport = page.getViewport({ scale: Math.min(2, maxSide / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) throw new Error('페이지를 그릴 캔버스를 만들 수 없습니다.');
  const render = page.render({ canvasContext, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await render.promise;
    signal.throwIfAborted();
    return canvas;
  } finally {
    signal.removeEventListener('abort', cancel);
    page.cleanup();
  }
}

async function assertPageSize(pdf: PDFDocumentProxy, page: LayoutTranslationPage): Promise<void> {
  if (page.page < 1 || page.page > pdf.numPages) throw new Error('번역의 페이지 번호가 원본 PDF와 맞지 않습니다. 다시 생성해 주세요.');
  const viewport = (await pdf.getPage(page.page)).getViewport({ scale: 1 });
  if (Math.abs(viewport.width - page.width) > 1 || Math.abs(viewport.height - page.height) > 1) {
    throw new Error('번역의 페이지 크기·회전이 원본 PDF와 맞지 않습니다. 원본을 유지합니다. 다시 생성해 주세요.');
  }
}

/** Standalone: PaperProvider is required, but no PDF viewer or ViewerProvider is needed. */
export function LayoutTranslationView() {
  const { paper } = usePaper();
  return <LayoutTranslationBody key={paper.id} />;
}

function LayoutTranslationBody() {
  const { paper } = usePaper();
  const [document, setDocument] = useState<LayoutTranslationDocument | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [sourceLoading, setSourceLoading] = useState(paper.hasPdf);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [mode, setMode] = useState<'original' | 'ko'>('ko');
  const [ocr, setOcr] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [rendered, setRendered] = useState<PageRender | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const canvasHost = useRef<HTMLDivElement>(null);
  const exportController = useRef<AbortController | null>(null);
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const result = await api<{ document: LayoutTranslationDocument | null }>(`/api/papers/${paper.id}/layout-translation`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDocument(result.document);
      setLoadError(null);
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setLoaded(true);
    }
  }, [paper.id]);

  const job = useJob('layoutTranslation', {
    onEvent(event) {
      if (event === 'page' || event === 'snapshot') void load();
    },
    onFinish() {
      setCancelRequested(false);
      void load();
    },
  });

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    setSource(null);
    setSourceError(null);
    setSourceLoading(paper.hasPdf);
    if (paper.hasPdf) void (async () => {
      try {
        const response = await fetch(`/api/papers/${paper.id}/pdf`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 404 ? '원본 PDF가 없습니다. 논문에 원본 PDF를 연결해 주세요.' : `원본 PDF를 읽지 못했습니다 (${response.status}).`);
        const bytes = await response.arrayBuffer();
        controller.signal.throwIfAborted();
        if (!globalThis.crypto?.subtle) throw new Error('이 환경에서는 PDF 해시를 검증할 수 없습니다. localhost 또는 보안 연결에서 다시 열어 주세요.');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        controller.signal.throwIfAborted();
        task = getDocument({ data: new Uint8Array(bytes) });
        const pdf = await task.promise;
        controller.signal.throwIfAborted();
        setSource({ pdf, hash });
        setPage((current) => Math.min(current, pdf.numPages));
      } catch (error) {
        if (!controller.signal.aborted) setSourceError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setSourceLoading(false);
      }
    })();
    return () => {
      controller.abort();
      exportController.current?.abort();
      void task?.destroy().catch(() => {});
    };
  }, [paper.id, paper.hasPdf, sourceVersion]);

  const matchesSource = !!source && !!document && document.pdfHash === source.hash;
  const currentTranslation = matchesSource ? document.pages.find((item) => item.page === page) : undefined;
  const translatedPages = useMemo(() => matchesSource ? [...document.pages].sort((a, b) => a.page - b.page) : [], [matchesSource, document]);
  const pageCount = source?.pdf.numPages ?? 0;

  useEffect(() => { setPageInput(String(page)); }, [page]);

  useEffect(() => {
    const controller = new AbortController();
    setRendered(null);
    setRenderError(null);
    setRendering(!!source);
    if (source) void (async () => {
      try {
        const original = await renderOriginal(source.pdf, page, 2304, controller.signal);
        if (controller.signal.aborted) return;
        setRendered({ page, original });
        if (currentTranslation) {
          await assertPageSize(source.pdf, currentTranslation);
          const translated = await renderLayoutPage(original, currentTranslation, { signal: controller.signal });
          if (!controller.signal.aborted) setRendered({ page, original, translated });
        }
      } catch (error) {
        if (!controller.signal.aborted) setRenderError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setRendering(false);
      }
    })();
    return () => controller.abort();
  }, [source, page, currentTranslation, renderVersion]);

  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;
    if (!rendered || rendered.page !== page) {
      host.replaceChildren();
      return;
    }
    const canvas = mode === 'ko' && rendered.translated ? rendered.translated.canvas : rendered.original;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${page}쪽 ${mode === 'ko' && rendered.translated ? '한국어 배치 번역' : '원본 PDF'}. 판독한 텍스트는 아래 목록에서 확인할 수 있습니다.`);
    host.replaceChildren(canvas);
  }, [rendered, mode, page]);

  const generate = async (all: boolean) => {
    if (!source || starting || job.running) return;
    setStarting(true);
    setActionError(null);
    setCancelRequested(false);
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/papers/${paper.id}/layout-translation`, {
        method: 'POST', json: { ...(all ? {} : { pages: [page] }), ocr },
      });
      job.attach(jobId);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const cancelGeneration = async () => {
    if (cancelRequested) return;
    setCancelRequested(true);
    try {
      await job.cancel();
    } catch (error) {
      setCancelRequested(false);
      setActionError(errorMessage(error));
    }
  };

  const download = async (all: boolean) => {
    if (!source || !matchesSource || exportController.current) return;
    const pages = all ? translatedPages : currentTranslation ? [currentTranslation] : [];
    if (!pages.length) return;
    const controller = new AbortController();
    exportController.current = controller;
    setActionError(null);
    setExportMessage(null);
    setExportProgress({ completed: 0, total: pages.length });
    try {
      const blob = await exportLayoutPdf({
        pages,
        signal: controller.signal,
        onProgress: (completed, total) => setExportProgress({ completed, total }),
        renderPage: async (translation) => {
          await assertPageSize(source.pdf, translation);
          const original = await renderOriginal(source.pdf, translation.page, 3200, controller.signal);
          return renderLayoutPage(original, translation, { signal: controller.signal });
        },
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      const title = paper.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'paper';
      anchor.download = `${title}-한국어-배치${all ? '' : `-${page}쪽`}.pdf`;
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExportMessage('한국어 PDF 다운로드를 시작했습니다. 원본 PDF는 변경하지 않았습니다.');
    } catch (error) {
      if (controller.signal.aborted) setExportMessage('PDF 내보내기를 취소했습니다.');
      else setActionError(errorMessage(error));
    } finally {
      if (exportController.current === controller) exportController.current = null;
      setExportProgress(null);
    }
  };

  const onPageKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!pageCount || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest('input, button, select, textarea, a, summary, [contenteditable="true"]')) return;
    const target = event.key === 'ArrowLeft' ? page - 1 : event.key === 'ArrowRight' ? page + 1 : event.key === 'Home' ? 1 : event.key === 'End' ? pageCount : null;
    if (target !== null) {
      event.preventDefault();
      setPage(Math.max(1, Math.min(pageCount, target)));
    }
  };

  const placements = rendered?.page === page ? rendered.translated?.placements : undefined;
  const overflow = placements?.filter((placement) => placement.status !== 'translated' && placement.status !== 'protected') ?? [];
  const busy = starting || job.running || !job.loaded;
  const validPageInput = /^\d+$/.test(pageInput) && Number(pageInput) >= 1 && Number(pageInput) <= pageCount;

  return <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="원본 배치 한국어 번역" tabIndex={0} onKeyDown={onPageKey}>
    <header className="shrink-0 space-y-2 border-b border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-fg">원본 배치 한국어 번역</h2>
        {matchesSource && document.by && <ModelBadge by={document.by} />}
      </div>
      <p className="text-[12px] leading-relaxed text-fg-muted">본문·표·그림 안 글자의 위치를 살펴 한국어를 배치합니다. 안전하게 지울 수 없거나 칸에 맞지 않는 글자는 원본을 보존하고, 한국어 전문을 아래 목록과 내보낸 PDF 부록에 표시합니다. 기존 문단 번역과 별도이며 원본 PDF는 바꾸지 않습니다.</p>
      <AiUsageNotice profile="quick" detail="선택한 페이지의 인식된 원문을 빠른 작업 모델로 번역하며 분량에 따라 여러 번 요청합니다. OCR을 켜면 로컬 CPU 처리 시간도 늘어납니다. 저장된 결과 보기와 PDF 다운로드는 AI를 호출하지 않습니다." />
      <label className="flex items-start gap-2 text-[12px] leading-relaxed text-fg-muted">
        <input type="checkbox" className="mt-0.5 accent-accent" checked={ocr} disabled={busy} onChange={(event) => setOcr(event.target.checked)} />
        <span>이미지·스캔 영어 OCR 포함 — 이 기기에서 영어 글자를 인식합니다. 클라우드 OCR로 이미지를 보내지 않으며 인식된 텍스트만 번역 모델에 전달합니다. 그림·스캔의 안전한 원문 제거를 보장할 수 없어 원본과 별도 전문으로 제공될 수 있습니다. 작은 글자·기울어진 글자·비영어 문자는 누락될 수 있습니다.</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className={primaryBtnCls} disabled={busy || !source} onClick={() => void generate(false)}>{starting ? '요청 중…' : `현재 ${page}쪽 ${currentTranslation ? '이어 번역' : '번역'}`}</button>
        <button className={smallBtnCls} disabled={busy || !source} onClick={() => void generate(true)}>전체 {pageCount || ''}쪽 번역</button>
        <span className="text-[12px] text-fg-muted">검증된 기존 번역은 재사용하고 미완료 영역을 처리합니다. 취소해도 성공한 번역은 유지됩니다.</span>
      </div>
      <JobBar job={job.job} onCancel={() => void cancelGeneration()} label="원본 배치 번역 중" />
      {cancelRequested && job.running && <p role="status" className="text-[12px] text-fg-muted">취소 요청 중… 완료된 페이지는 보존합니다.</p>}
      {isCancelled(job.job) && <p role="status" className="text-[12px] text-fg-muted">번역을 취소했습니다. 저장된 완료 페이지는 계속 볼 수 있습니다.</p>}
      {actionError && <p role="alert" className="text-[13px] text-danger">{actionError}</p>}
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {!paper.hasPdf && <p role="status" className="text-[13px] text-fg-muted">원본 PDF가 없습니다. 논문에 PDF를 연결하면 원본 배치 번역을 사용할 수 있습니다.</p>}
      {sourceLoading && <Spinner text="원본 PDF 불러오기·해시 검증 중…" />}
      {sourceError && <div role="alert" className="space-y-2 text-[13px] text-danger"><p>{sourceError}</p><button className={smallBtnCls} onClick={() => setSourceVersion((version) => version + 1)}>원본 다시 불러오기</button></div>}
      {loadError && <div role="alert" className="mb-3 text-[13px] text-danger">번역을 불러오지 못했습니다: {loadError} <button className={smallBtnCls} onClick={() => void load()}>번역 다시 불러오기</button></div>}
      {!loaded && !loadError && <Spinner text="저장된 배치 번역 확인 중…" />}
      {source && <>
        {document && !matchesSource && <div role="alert" className="mb-3 space-y-2 rounded-lg border border-warning/30 p-3 text-[13px] text-warning"><p>저장된 번역의 PDF 해시가 원본과 다릅니다. 잘못된 위치에 번역을 덮어쓰지 않도록 원본만 표시하고 다운로드를 막았습니다. 원본을 새로 불러온 뒤 필요하면 다시 번역해 주세요.</p><button className={smallBtnCls} onClick={() => { setSourceVersion((version) => version + 1); void load(); }}>원본·번역 다시 불러오기</button></div>}
        <nav aria-label="배치 번역 페이지 이동" className="mb-3 flex flex-wrap items-center gap-2">
          <button className={smallBtnCls} disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="이전 페이지">이전</button>
          <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); if (validPageInput) setPage(Number(pageInput)); }}>
            <label htmlFor={`layout-page-${paper.id}`} className="sr-only">페이지 번호</label>
            <input id={`layout-page-${paper.id}`} className={`${inputCls} !w-20 !py-1 tabular-nums`} type="number" min={1} max={pageCount} step={1} value={pageInput} onChange={(event) => setPageInput(event.target.value)} aria-invalid={!validPageInput} />
            <span className="text-[12px] text-fg-muted">/ {pageCount}</span>
            <button className={smallBtnCls} disabled={!validPageInput}>이동</button>
          </form>
          <button className={smallBtnCls} disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} aria-label="다음 페이지">다음</button>
          <div className="flex gap-1" role="group" aria-label="페이지 표시 언어">
            <button className={chipCls(mode === 'original')} aria-pressed={mode === 'original'} onClick={() => setMode('original')}>원본</button>
            <button className={chipCls(mode === 'ko')} aria-pressed={mode === 'ko'} onClick={() => setMode('ko')}>한국어</button>
          </div>
          <span className="text-[11px] text-fg-dim">페이지 영역에서 ← → · Home · End로 이동</span>
        </nav>
        <div role="status" aria-live="polite" className="mb-2 text-[12px] text-fg-muted">{page} / {pageCount}쪽 · {currentTranslation ? '저장된 번역 있음' : '아직 배치 번역 없음 — 원본 표시'} · 완료 {translatedPages.length}쪽</div>
        {!currentTranslation && loaded && !loadError && <p className="mb-3 text-[13px] text-fg-muted">이 페이지의 한국어 배치 번역이 없습니다. 위의 현재 페이지 또는 전체 번역 버튼으로 생성하세요. 원본이 바뀌면 이전 파일의 번역은 사용하지 않습니다.</p>}
        {currentTranslation && <div className="mb-3 space-y-1 text-[12px] leading-relaxed text-fg-muted">
          <p>{document?.ocr ? '저장된 일부 페이지에 로컬 OCR을 사용했습니다. 미검출·오인식 문자가 있을 수 있으며, 모든 페이지·이미지 글자의 번역을 보장하지 않습니다.' : '이미지·스캔 글자는 OCR 없이는 읽지 못할 수 있습니다. 필요한 경우 OCR을 선택해 다시 번역하세요.'}</p>
          {currentTranslation.regions.length === 0 && <p className="text-warning">이 페이지에서 글자 영역을 인식하지 못했습니다. 원본 이미지의 글자는 아직 번역되지 않았습니다. 영어 스캔이면 OCR을 선택해 다시 시도하고, 미검출·비영어 글자는 원본으로 확인해 주세요.</p>}
          {currentTranslation.warnings.map((warning, index) => <p key={index} className="text-warning">{warning}</p>)}
        </div>}
        {rendering && <Spinner text={rendered ? '한국어 배치 계산 중…' : '현재 페이지 그리는 중…'} />}
        {renderError && <div role="alert" className="mb-3 text-[13px] text-danger">{renderError} 원본은 가능한 경우 그대로 표시합니다. <button className={smallBtnCls} onClick={() => setRenderVersion((version) => version + 1)}>페이지 다시 그리기</button></div>}
        <figure className="mx-auto max-w-[1100px] overflow-hidden rounded border border-line bg-white shadow-sm">
          <div ref={canvasHost} />
          <figcaption className="border-t border-line bg-surface px-3 py-2 text-[12px] text-fg-muted">{page}쪽 · {mode === 'ko' && rendered?.translated ? '한국어 배치 — 원본 유지 항목은 아래 전문 참조' : '원본 PDF'}. 캔버스의 인식된 원문·한국어는 아래 텍스트 목록으로도 읽을 수 있습니다.</figcaption>
        </figure>
        {currentTranslation && <div className="mx-auto mt-4 max-w-[1100px] space-y-3">
          <section aria-label="원본 유지 및 넘침 번역 전문" className="rounded-lg border border-line p-3">
            <h3 className="mb-2 text-[14px] font-semibold text-fg">원본 유지·칸 넘침 전문 ({overflow.length})</h3>
            <p className="mb-2 text-[12px] text-fg-muted">그림·표 배경을 손상시킬 수 있는 영역, 회전 글자, 칸에 맞지 않는 긴 번역은 지우거나 잘라 넣지 않습니다. 아래 원문과 한국어는 생략 없이 제공되며 저장된 한국어는 PDF 부록에도 포함됩니다. 수식·숫자·고유명사 등 번역하지 않는 보호 영역은 아래 전체 목록에서 확인할 수 있습니다.</p>
            {!placements ? <p className="text-[12px] text-fg-muted">{renderError ? '페이지 합성에 실패했습니다. 아래 전체 텍스트 목록에서 저장된 번역을 확인하세요.' : '배치 결과를 계산하고 있습니다.'}</p> : overflow.length === 0 ? <p className="text-[12px] text-fg-muted">인식된 영역 중 별도 전문으로 넘긴 항목이 없습니다. 미검출 이미지 글자까지 번역되었다는 뜻은 아닙니다.</p> : <div className="space-y-3">{overflow.map((placement) => <PlacementText key={placement.id} placement={placement} />)}</div>}
          </section>
          <details className="rounded-lg border border-line p-3 text-[13px]">
            <summary className="cursor-pointer font-medium text-fg">인식된 모든 원문·한국어 ({currentTranslation.regions.length})</summary>
            <div className="mt-3 space-y-3">{currentTranslation.regions.map((region) => <div key={region.id} className="space-y-1 border-t border-line pt-2">
              <p className="text-[11px] text-fg-muted">{region.id} · {region.origin === 'ocr' ? 'OCR 인식' : 'PDF 텍스트'}{region.reason ? ` · ${region.reason}` : ''}</p>
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-muted" lang="en">{region.source}</p>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg" lang="ko">{region.ko ?? '한국어 번역 없음 — 원본을 유지합니다.'}</p>
            </div>)}</div>
          </details>
        </div>}
        <section aria-label="한국어 PDF 다운로드" className="mx-auto mt-4 max-w-[1100px] space-y-2 rounded-lg border border-line p-3">
          <h3 className="text-[14px] font-semibold text-fg">한국어 PDF 다운로드</h3>
          <p className="text-[12px] leading-relaxed text-fg-muted">현재 페이지 또는 저장된 완료 페이지 전체를 새 PDF로 만듭니다. 미완료 페이지는 포함하지 않습니다. 안전하지 않은 영역의 원문·한국어 전문은 부록에 포함됩니다. 페이지는 이미지로 저장되어 원본의 검색·선택 가능한 텍스트 레이어를 유지하지 않습니다.</p>
          <div className="flex flex-wrap gap-2">
            <button className={smallBtnCls} disabled={!currentTranslation || !!exportProgress} onClick={() => void download(false)}>현재 {page}쪽 PDF</button>
            <button className={smallBtnCls} disabled={!translatedPages.length || !!exportProgress} onClick={() => void download(true)}>완료된 {translatedPages.length}쪽 전체 PDF</button>
            {exportProgress && <button className={smallBtnCls} onClick={() => exportController.current?.abort()}>PDF 내보내기 취소</button>}
          </div>
          {exportProgress && <p role="status" aria-live="polite" className="text-[12px] text-fg-muted">PDF 준비 중… {exportProgress.completed} / {exportProgress.total}쪽</p>}
          {exportMessage && <p role="status" className="text-[12px] text-fg-muted">{exportMessage}</p>}
        </section>
      </>}
    </div>
  </section>;
}

function PlacementText({ placement }: { placement: LayoutPlacement }) {
  const label = placement.status === 'overflow' ? '칸 넘침' : placement.status === 'untranslated' ? '미번역' : placement.status === 'protected' ? '보호 영역' : '원본 유지';
  return <article className="space-y-1 border-t border-line pt-2">
    <h4 className="text-[12px] font-medium text-fg">{placement.id} · {label}</h4>
    {placement.reason && <p className="text-[12px] text-warning">{placement.reason}</p>}
    <div><span className="text-[11px] text-fg-muted">원문</span><p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-muted">{placement.source}</p></div>
    <div><span className="text-[11px] text-fg-muted">한국어</span><p lang="ko" className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">{placement.ko ?? '한국어 번역 없음 — 원본을 유지합니다.'}</p></div>
  </article>;
}
