import * as React from 'react';

interface State {
  crashed: boolean;
}

export class ModuleErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[beacon] module crashed', error, info.componentStack);
  }

  override render(): React.ReactNode {
    if (this.state.crashed) {
      return (
        <div role="alert" data-testid="beacon-error-boundary" style={{ padding: 24 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginBottom: 12 }}>Module crashed</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            Something went wrong rendering this module. Try closing the tab and reopening.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
