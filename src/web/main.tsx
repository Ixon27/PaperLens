import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';
import { initTheme } from './state/theme';

// `darwin` / `win32`: the macOS window has no title bar, so the app header takes its place (styles.css).
if (window.paperReaderDesktop) document.documentElement.dataset.desktop = window.paperReaderDesktop.platform;
initTheme();

// No StrictMode: the PDF.js viewer inside react-pdf-highlighter-extended is imperative and
// breaks under double-invoked effects.
createRoot(document.getElementById('root')!).render(<App />);
