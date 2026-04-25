import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useTabStore } from './stores/tab-store';
import './index.css';

const rootNode = document.getElementById('root');
if (!rootNode) throw new Error('Root element missing');

ReactDOM.createRoot(rootNode).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.DEV || import.meta.env.MODE === 'test' || (typeof process !== 'undefined' && process.env?.LLAMACTL_TEST_PROFILE)) {
  // Test-only: expose the tab store so smoke tests can introspect / drive it.
  // @ts-expect-error — test-only window attachment
  window.useTabStore = useTabStore;
}
