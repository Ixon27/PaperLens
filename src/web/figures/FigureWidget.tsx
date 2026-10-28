import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FIGURE_KIND_LABELS, type FigureSpec } from '../../shared/figure-spec';
import { SourceChip } from '../components/SourceChip';
import { CompareWidget, TableWidget } from './dataWidgets';
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
  return (
    <WidgetBoundary identity={spec}>
      <div className="space-y-3 rounded-xl border border-line bg-raised p-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="mr-auto text-[14px] font-semibold text-fg">{spec.title}</h4>
            <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-fg-muted">{FIGURE_KIND_LABELS[spec.kind]}</span>
            {spec.approx && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning" title="그림에서 눈으로 읽은 값이라 원문과 다를 수 있습니다">근사값</span>}
          </div>
          <p className="text-[13px] text-fg">{spec.takeaway}</p>
          <p className="text-[12px] text-fg-dim">{spec.howTo}</p>
        </div>
        <WidgetContent spec={spec} imageUrl={imageUrl} />
        {(spec.sources.length > 0 || spec.notes.length > 0) && <div className="border-t border-line pt-2 text-[12px] text-fg-muted">
          {spec.sources.length > 0 && <div>근거 {spec.sources.map((source, i) => <SourceChip key={i} page={source.page} endPage={null} label={`p.${source.page}`} quote={source.quote} />)}</div>}
          {spec.notes.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{spec.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
        </div>}
      </div>
    </WidgetBoundary>
  );
}
