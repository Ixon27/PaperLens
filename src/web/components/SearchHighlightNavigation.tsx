import { useEffect } from 'react';
import { toAppHighlight } from '../pdf/PdfPane';
import { usePaper } from '../state/paper';
import { useViewer } from '../state/viewer';

/** A saved note search opens the saved highlight, including area-only notes. */
export function SearchHighlightNavigation() {
  const { paper, highlights } = usePaper();
  const { utilsRef, setTab, setSidebarOpen, setPdfMode } = useViewer();
  useEffect(() => {
    let timer: number | undefined;
    const navigate = () => {
      clearInterval(timer);
      if (!window.location.hash.startsWith('#highlight-')) return;
      let id: string;
      try { id = decodeURIComponent(window.location.hash.slice(11)); } catch { return; }
      const highlight = highlights.find((h) => h.id === id);
      if (!highlight) return;
      setTab('highlights');
      setSidebarOpen(true);
      setPdfMode('split');
      let attempts = 0;
      timer = window.setInterval(() => {
        const utils = utilsRef.current;
        const viewer = utils?.getViewer();
        if (utils && viewer?.getPageView(highlight.position.boundingRect.pageNumber - 1)?.viewport) {
          utils.scrollToHighlight(toAppHighlight(highlight));
          clearInterval(timer);
        } else if (++attempts >= 100) clearInterval(timer);
      }, 100);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => { clearInterval(timer); window.removeEventListener('hashchange', navigate); };
  }, [paper.id, highlights, utilsRef, setTab, setSidebarOpen, setPdfMode]);
  return null;
}
