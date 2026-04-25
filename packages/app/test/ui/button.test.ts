import { describe, test, expect } from 'bun:test';
import { buttonClasses, type ButtonVariant, type ButtonSize } from '../../src/ui/button';

describe('buttonClasses', () => {
  const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'outline', 'destructive'];
  const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

  test('every variant × size combination returns a non-empty class list', () => {
    for (const v of variants) {
      for (const s of sizes) {
        const out = buttonClasses(v, s);
        expect(out.length).toBeGreaterThan(10);
        expect(out).toContain('bcn-btn');
        expect(out).toContain(`bcn-btn--${v}`);
        expect(out).toContain(`bcn-btn--${s}`);
      }
    }
  });

  test('unknown variant falls back to primary', () => {
    expect(buttonClasses('nope' as ButtonVariant, 'md')).toContain('bcn-btn--primary');
  });
});
