import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useTabStore } from './stores/tab-store';
import { useThemeStore } from './stores/theme-store';
import './index.css';

const rootNode = document.getElementById('root');
if (!rootNode) throw new Error('Root element missing');

ReactDOM.createRoot(rootNode).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Expose the tab + theme stores for the Tier-A smoke harness + a small
// set of in-renderer debugging affordances. This is intentionally
// unconditional — production builds running in headless CI couldn't
// satisfy any DEV/test env gate, and a zustand store on `window` is
// harmless in shipped builds (no PII, no security surface).
// @ts-expect-error — debug + test-only window attachment
window.useTabStore = useTabStore;
// @ts-expect-error — debug + test-only window attachment
window.useThemeStore = useThemeStore;
