import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Switch } from 'wouter';
import { api } from './api';
import type { Settings } from './types';
import { OnboardingDialog } from './components/OnboardingDialog';
import { EngineSwitch } from './components/EngineSwitch';
import { SettingsDialog } from './components/SettingsDialog';
import { ToastProvider } from './components/Toast';
import { Library } from './pages/Library';
import { Workspace } from './pages/Workspace';

function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => window.paperReaderDesktop?.onOpenSettings(() => setSettingsOpen(true)), []);
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
      <Link href="/" className="text-[15px] font-bold tracking-tight text-stone-900">
        paper-reader
      </Link>
      <div className="flex-1" />
      <EngineSwitch />
      <button
        className="rounded-md border border-stone-300 px-2.5 py-1 text-[12px] hover:bg-stone-100"
        onClick={() => setSettingsOpen(true)}
      >
        설정
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

export function App() {
  const [setupOpen, setSetupOpen] = useState(false);
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
  useEffect(() => { void loadSetup(); }, [loadSetup]);
  return (
    <ToastProvider>
      <div className="flex h-full flex-col">
        <Header />
        {setupError && <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {setupError} <button className="ml-2 underline" onClick={() => void loadSetup()}>다시 시도</button>
        </div>}
        <main className="min-h-0 flex-1">
          <Switch>
            <Route path="/">
              <Library />
            </Route>
            <Route path="/paper/:id">{(params) => <Workspace key={params.id} id={params.id} />}</Route>
            <Route>
              <div className="p-8 text-stone-500">없는 페이지입니다.</div>
            </Route>
          </Switch>
        </main>
      </div>
      {setupOpen && <OnboardingDialog onDone={() => setSetupOpen(false)} />}
    </ToastProvider>
  );
}
