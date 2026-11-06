import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { BookOpen, ChevronRight, Moon, PanelLeft, Search, Settings as SettingsIcon, Sun } from 'lucide-react';
import { api } from './api';
import type { Settings, UpdateStatus } from './types';
import { AiPicker } from './components/AiPicker';
import { iconBtnCls } from './components/Dialog';
import { OnboardingDialog } from './components/OnboardingDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { isMac, SETTINGS_SHORTCUT } from './labels';
import { toggleTheme, useResolvedTheme } from './state/theme';
import { ToastProvider } from './components/Toast';
import { Library } from './pages/Library';
import { Workspace } from './pages/Workspace';

function ThemeToggle() {
  const dark = useResolvedTheme() === 'dark';
  const label = dark ? '밝은 화면으로 전환' : '어두운 화면으로 전환';
  return (
    <button className={iconBtnCls} aria-label={label} title={label} onClick={toggleTheme}>
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function Header({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar(): void }) {
  const [location, navigate] = useLocation();
  const focusSearch = () => {
    if (location !== '/') navigate('/');
    requestAnimationFrame(() => document.getElementById('library-search')?.focus());
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => window.paperReaderDesktop?.onOpenSettings(() => setSettingsOpen(true)), []);
  // The macOS app menu owns ⌘,; the Windows window has no menu bar, so the page handles Ctrl+,.
  useEffect(() => {
    if (!window.paperReaderDesktop || isMac) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <header className="paper-chrome ghost-titlebar app-drag">
      <div className={`paper-sidebar-top ghost-titlebar-side ${window.paperReaderDesktop && isMac ? 'has-traffic-lights' : ''}`}>
        <button
          className={iconBtnCls}
          aria-label="라이브러리 사이드바"
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
          title="사이드바 표시 전환"
        >
          <PanelLeft size={16} />
        </button>
        <div className="flex-1" />
        <button className={iconBtnCls} aria-label="논문 검색" title="논문 검색" onClick={focusSearch}>
          <Search size={16} />
        </button>
      </div>
      <div className="paper-main-header ghost-titlebar-main">
        <Link href="/" className="paper-breadcrumb">
          <BookOpen size={15} />
          <span>라이브러리</span>
        </Link>
        {location.startsWith('/paper/') && (
          <>
            <ChevronRight size={13} className="text-fg-dim" />
            <span className="paper-current-page">논문 작업 공간</span>
          </>
        )}
        <div className="flex-1" />
        <div className="paper-header-ai">
          <AiPicker />
        </div>
        <ThemeToggle />
        <button
          className={iconBtnCls}
          aria-label="설정"
          title={window.paperReaderDesktop ? `설정 (${SETTINGS_SHORTCUT})` : '설정'}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon size={16} />
        </button>
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

/** A slim notice when GitHub has a newer release; checked in the background, at most once a day. */
function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!window.paperReaderDesktop) return;
    let alive = true;
    api<UpdateStatus>('/api/update')
      .then((u) => alive && setUpdate(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!update?.available || !update.latest || !update.url) return null;
  const dismiss = () => {
    setUpdate(null);
    void api('/api/settings', { method: 'PUT', json: { dismissedUpdate: update.latest } }).catch(() => {});
  };
  return (
    <div role="status" className="flex items-center gap-3 border-b border-accent/30 bg-accent-soft px-4 py-1.5 text-[13px] text-fg">
      <span className="min-w-0 flex-1 truncate">
        새 버전 <b>PaperLens {update.latest}</b>이 나왔습니다. 지금은 {update.current}입니다.
      </span>
      <a className="shrink-0 font-medium text-accent underline" href={update.url} target="_blank" rel="noreferrer">
        받으러 가기
      </a>
      <button className="shrink-0 text-fg-muted hover:text-fg" onClick={dismiss}>
        닫기
      </button>
    </div>
  );
}

export function App() {
  const [setupOpen, setSetupOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const loadSetup = useCallback(async () => {
    if (!window.paperReaderDesktop) return;
    setSetupError(null);
    try {
      const settings = await api<Settings>('/api/settings');
      setSetupOpen(!settings.onboardingDone);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : '초기 설정을 확인하지 못했습니다');
    }
  }, []);
  useEffect(() => {
    void loadSetup();
  }, [loadSetup]);
  return (
    <ToastProvider>
      <div className={`paper-app ghost-shell flex h-full flex-col ${sidebarOpen ? '' : 'sidebar-hidden'}`}>
        <Header sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
        <UpdateNotice />
        {setupError && (
          <div role="alert" className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">
            {setupError}{' '}
            <button className="ml-2 underline" onClick={() => void loadSetup()}>
              다시 시도
            </button>
          </div>
        )}
        <main className="min-h-0 flex-1">
          <Switch>
            <Route path="/">
              <Library sidebarOpen={sidebarOpen} />
            </Route>
            <Route path="/paper/:id">{(params) => <Workspace key={params.id} id={params.id} />}</Route>
            <Route>
              <div className="p-8 text-fg-muted">없는 페이지입니다.</div>
            </Route>
          </Switch>
        </main>
      </div>
      {setupOpen && <OnboardingDialog onDone={() => setSetupOpen(false)} />}
    </ToastProvider>
  );
}
