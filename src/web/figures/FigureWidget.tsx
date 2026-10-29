import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { FigureSpec } from '../../shared/figure-spec';
import { smallBtnCls } from '../components/Dialog';
import { SourceChip } from '../components/SourceChip';
import { CompareWidget, TableWidget } from './dataWidgets';
import { FigureCloseContext, FigureDisplayContext } from './FigureDisplayContext';
import { HotspotWidget } from './HotspotWidget';
import { LineWidget, BarWidget, ScatterWidget, StackedWidget, BoxWidget, HeatmapWidget, HistogramWidget, FieldWidget } from './plotWidgets';
import { VolcanoWidget, OrdinationWidget, SurvivalWidget, DoseResponseWidget, FormulaWidget, RocWidget } from './statWidgets';
import { FlowWidget, TimelineWidget, TreeWidget, NetworkWidget, VennWidget } from './structureWidgets';

class WidgetBoundary extends Component<{ identity: FigureSpec; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { console.error('Figure widget:', error); }
  componentDidUpdate(previous: Readonly<{ identity: FigureSpec }>) {
    if (previous.identity !== this.props.identity && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed
      ? <p role="alert" className="rounded-lg bg-danger-soft p-3 text-[13px] text-danger">이 위젯을 그리지 못했습니다 — 다른 형식으로 다시 만들어 보세요</p>
      : this.props.children;
  }
}

function WidgetContent({ spec, imageUrl }: { spec: FigureSpec; imageUrl: string | null }) {
  switch (spec.kind) {
    case 'line': return <LineWidget spec={spec} />;
    case 'bar': return <BarWidget spec={spec} />;
    case 'scatter': return <ScatterWidget spec={spec} />;
    case 'stacked': return <StackedWidget spec={spec} />;
    case 'box': return <BoxWidget spec={spec} />;
    case 'heatmap': return <HeatmapWidget spec={spec} />;
    case 'histogram': return <HistogramWidget spec={spec} />;
    case 'field': return <FieldWidget spec={spec} />;
    case 'volcano': return <VolcanoWidget spec={spec} />;
    case 'ordination': return <OrdinationWidget spec={spec} />;
    case 'survival': return <SurvivalWidget spec={spec} />;
    case 'roc': return <RocWidget spec={spec} />;
    case 'doseResponse': return <DoseResponseWidget spec={spec} />;
    case 'formula': return <FormulaWidget spec={spec} />;
    case 'compare': return <CompareWidget spec={spec} />;
    case 'table': return <TableWidget spec={spec} />;
    case 'flow': return <FlowWidget spec={spec} />;
    case 'timeline': return <TimelineWidget spec={spec} />;
    case 'tree': return <TreeWidget spec={spec} />;
    case 'network': return <NetworkWidget spec={spec} />;
    case 'venn': return <VennWidget spec={spec} />;
    case 'hotspot': return <HotspotWidget spec={spec} imageUrl={imageUrl} />;
  }
}

export function FigureWidget({ spec, imageUrl }: { spec: FigureSpec; imageUrl: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    expandButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      } else if (event.key === 'Tab' && container.current) {
        const focusable = Array.from(container.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !container.current.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !container.current.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus({ preventScroll: true });
    };
  }, [expanded]);

  return (
    <WidgetBoundary identity={spec}>
      <FigureDisplayContext.Provider value={expanded}>
        <FigureCloseContext.Provider value={() => setExpanded(false)}>
        <div
          ref={container}
          role={expanded ? 'dialog' : undefined}
          aria-modal={expanded || undefined}
          aria-label={expanded ? `${spec.title} 전체 화면` : undefined}
          className={expanded
            ? 'figure-fullscreen no-drag fixed inset-0 z-[100] overflow-y-auto bg-canvas p-3 text-fg sm:p-6'
            : 'rounded-xl border border-line bg-raised p-3'}
        >
          <div className={`space-y-3 ${expanded ? 'mx-auto max-w-[1600px]' : ''}`}>
            <div className={`space-y-1 ${expanded ? 'sticky top-0 z-10 border-b border-line bg-canvas pb-3' : ''}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <h4 className="mr-auto min-w-0 text-[14px] font-semibold text-fg">{spec.title}</h4>
                {spec.approx && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning" title="그림에서 눈으로 읽은 값이라 원문과 다를 수 있습니다">근사값</span>}
                <button ref={expandButton} type="button" className={`${smallBtnCls} shrink-0 ${expanded ? 'no-drag min-h-8' : ''}`} aria-expanded={expanded}
                  aria-label={expanded ? '전체 화면 닫기 (Esc)' : '위젯 전체 화면으로 확대'}
                  title={expanded ? '전체 화면 닫기 (Esc)' : '위젯 전체 화면으로 확대'}
                  onClick={() => setExpanded((value) => !value)}>
                  {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  {expanded ? '닫기 (Esc)' : '전체 화면'}
                </button>
              </div>
              <p className="text-[13px] leading-relaxed text-fg">{spec.takeaway}</p>
              <p className="text-[12px] leading-relaxed text-fg-muted">{spec.howTo}</p>
            </div>
            <WidgetContent spec={spec} imageUrl={imageUrl} />
            {(spec.sources.length > 0 || spec.notes.length > 0) && <div className="border-t border-line pt-2 text-[12px] text-fg-muted">
              {spec.sources.length > 0 && <div>근거 {spec.sources.map((source, i) => <SourceChip key={i} page={source.page} endPage={null} label={`p.${source.page}`} quote={source.quote} onNavigate={() => setExpanded(false)} />)}</div>}
              {spec.notes.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{spec.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
            </div>}
          </div>
        </div>
        </FigureCloseContext.Provider>
      </FigureDisplayContext.Provider>
    </WidgetBoundary>
  );
}
