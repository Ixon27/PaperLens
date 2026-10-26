import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';

// No StrictMode: the PDF.js viewer inside react-pdf-highlighter-extended is imperative and
// breaks under double-invoked effects.
createRoot(document.getElementById('root')!).render(<App />);
