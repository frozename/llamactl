import * as React from 'react';
import { useEffect, useState } from 'react';
import { Button, Kbd } from '@/ui';

const FIRST_RUN_KEY = 'beacon.tip.shown';

/**
 * 3-step onboarding overlay shown once per user after they first see
 * the Beacon shell. Remembered via `localStorage[beacon.tip.shown]`.
 */
export function FirstRunTip(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem(FIRST_RUN_KEY) !== '1') setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = (): void => {
    localStorage.setItem(FIRST_RUN_KEY, '1');
    setVisible(false);
  };

  const steps = [
    { title: 'Welcome to Beacon.', body: <>The left rail switches views — Explorer, Search, Tokens, etc. The Explorer tree opens any module (or a live workload) in a tab.</> },
    { title: 'Tabs persist.', body: <>Open as many as you need — they survive restarts. <Kbd>⌘W</Kbd> closes, <Kbd>⌘⇧T</Kbd> reopens, <Kbd>⌘1</Kbd>–<Kbd>⌘9</Kbd> jump by position.</> },
    { title: 'Command palette still works.', body: <>Hit <Kbd>⌘K</Kbd> or <Kbd>⌘⇧P</Kbd> anytime to fuzzy-find a module, workload, node, or action.</> },
  ];

  const current = steps[step] ?? steps[0]!;
  const isLast = step === steps.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-surface-overlay)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 3000,
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: '92vw',
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--r-xl)',
          padding: 28,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', marginBottom: 12 }}>
          Step {step + 1} of {steps.length}
        </div>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>{current.title}</h2>
        <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: '0 0 24px' }}>{current.body}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={dismiss}>Skip</Button>
          {!isLast && <Button variant="primary" onClick={() => setStep(step + 1)}>Next</Button>}
          {isLast && <Button variant="primary" onClick={dismiss}>Get started</Button>}
        </div>
      </div>
    </div>
  );
}
