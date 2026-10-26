import { useState } from 'react';
import { Link, Route, Switch } from 'wouter';
import { EngineSwitch } from './components/EngineSwitch';
import { SettingsDialog } from './components/SettingsDialog';
import { ToastProvider } from './components/Toast';
import { Library } from './pages/Library';
import { Workspace } from './pages/Workspace';

function Header() {
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  return (
    <ToastProvider>
      <div className="flex h-full flex-col">
        <Header />
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
    </ToastProvider>
  );
}
