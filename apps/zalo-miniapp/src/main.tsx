import 'zmp-ui/zaui.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { detectRuntime } from './lib/platform.ts';

const runtime = detectRuntime();
if (runtime === 'browser') {
  // Dev fallback: the Zalo host normally injects APP_ID/BASE_PATH. Give zmp-ui router a stable,
  // obviously fake value so the memory router resolves the same in dev and in the production bundle.
  const w = window as unknown as { APP_ID?: string; BASE_PATH?: string };
  w.APP_ID ??= 'synthetic-prototype';
  w.BASE_PATH ??= '/';
}

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');
createRoot(root).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
