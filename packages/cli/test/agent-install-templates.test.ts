import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSystemPlist,
  buildUserPlist,
  LAUNCHD_SYSTEM_TEMPLATE,
  LAUNCHD_USER_TEMPLATE,
  renderArgsArray,
  renderEnvDict,
  renderPlist,
  xmlEscape,
} from '../src/commands/agent-install/templates.js';
import type { BuildPlistOptions } from '../src/commands/agent-install/templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const USER_FIXTURE = join(FIXTURES, 'plist-user-snapshot.plist');
const SYSTEM_FIXTURE = join(FIXTURES, 'plist-system-snapshot.plist');

const CANONICAL_OPTS: BuildPlistOptions = {
  label: 'com.llamactl.agent',
  execPath: '/usr/local/bin/llamactl-agent',
  args: ['agent', 'serve', '--dir=/Users/alice/.llamactl-agent'],
  logDir: '/Users/alice/.llamactl-launchd-logs',
  env: {
    PATH: '/usr/local/bin:/usr/bin',
    DEV_STORAGE: '/Users/alice/DevStorage',
  },
};

const CANONICAL_SYSTEM_OPTS: BuildPlistOptions = {
  ...CANONICAL_OPTS,
  user: 'alice',
  group: 'staff',
  workingDir: '/Users/alice/.llamactl-agent',
};

/**
 * Snapshot helper: bless mode creates the fixture from the observed
 * output; otherwise it byte-compares. Set `UPDATE_SNAPSHOTS=1` or
 * delete the fixture to regenerate.
 */
function matchFixture(path: string, actual: string): void {
  const shouldWrite = process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(path);
  if (shouldWrite) {
    writeFileSync(path, actual, 'utf8');
  }
  const expected = readFileSync(path, 'utf8');
  expect(actual).toBe(expected);
}

describe('xmlEscape', () => {
  test('escapes &, <, > in order without double-escaping', () => {
    expect(xmlEscape('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
  });

  test('does not double-escape an already-escaped sequence', () => {
    // `A & B` escapes to `A &amp; B` — the critical invariant is that
    // the `&` pass runs first, so the `&amp;` it introduced is NOT
    // re-escaped by a later `<` or `>` pass.
    const input = 'A & <b> & C';
    const out = xmlEscape(input);
    expect(out).toBe('A &amp; &lt;b&gt; &amp; C');
    // Guard: no `&amp;amp;` anywhere (the classic double-escape bug).
    expect(out.includes('&amp;amp;')).toBe(false);
  });

  test('passes quotes and unicode through untouched', () => {
    const input = '"smart quotes \u2014 \u00e9"';
    expect(xmlEscape(input)).toBe('"smart quotes \u2014 \u00e9"');
  });
});

describe('renderArgsArray', () => {
  test('empty array → empty string', () => {
    expect(renderArgsArray([])).toBe('');
  });

  test('single arg → one indented line, no trailing newline', () => {
    expect(renderArgsArray(['serve'])).toBe('    <string>serve</string>');
  });

  test('multiple args → joined by newline, no leading or trailing newline', () => {
    const out = renderArgsArray(['agent', 'serve', '--flag']);
    expect(out).toBe(
      '    <string>agent</string>\n    <string>serve</string>\n    <string>--flag</string>',
    );
    expect(out.startsWith('\n')).toBe(false);
    expect(out.endsWith('\n')).toBe(false);
  });

  test('escapes special chars in arg values', () => {
    const out = renderArgsArray(['a&b', '<tag>', 'plain']);
    expect(out).toBe(
      '    <string>a&amp;b</string>\n    <string>&lt;tag&gt;</string>\n    <string>plain</string>',
    );
  });

  test('honours custom indent', () => {
    expect(renderArgsArray(['x'], '  ')).toBe('  <string>x</string>');
  });
});

describe('renderEnvDict', () => {
  test('empty map → empty string', () => {
    expect(renderEnvDict({})).toBe('');
  });

  test('preserves insertion order', () => {
    const out = renderEnvDict({ B: '2', A: '1', C: '3' });
    expect(out).toBe(
      '    <key>B</key><string>2</string>\n' +
        '    <key>A</key><string>1</string>\n' +
        '    <key>C</key><string>3</string>',
    );
  });

  test('escapes both keys and values', () => {
    const out = renderEnvDict({ 'key-with-&': 'value-with-<tag>' });
    expect(out).toBe(
      '    <key>key-with-&amp;</key><string>value-with-&lt;tag&gt;</string>',
    );
  });

  test('honours custom indent', () => {
    expect(renderEnvDict({ K: 'V' }, '  ')).toBe('  <key>K</key><string>V</string>');
  });
});

describe('renderPlist', () => {
  test('substitutes all placeholders', () => {
    expect(renderPlist('{{a}}{{b}}', { a: 'x', b: 'y' })).toBe('xy');
  });

  test('substitutes a repeated placeholder', () => {
    expect(renderPlist('{{a}}-{{a}}', { a: 'x' })).toBe('x-x');
  });

  test('throws with key name on missing var', () => {
    expect(() => renderPlist('hi {{unknown}}', {})).toThrow(
      /plist template missing var: unknown/,
    );
  });

  test('throws on unresolved placeholder left behind (belt-and-suspenders)', () => {
    // Contrived: the substitution value itself contains another `{{key}}`
    // pattern. Our regex replace runs ONE pass, so substituted content is
    // not re-scanned by the replace — but the final test does catch it.
    expect(() => renderPlist('{{a}}', { a: '{{other}}' })).toThrow(
      /plist template has unresolved placeholders/,
    );
  });

  test('does not touch non-placeholder curly braces', () => {
    expect(renderPlist('struct { x: 1 }', {})).toBe('struct { x: 1 }');
  });
});

describe('buildUserPlist', () => {
  test('byte-matches the user snapshot fixture', () => {
    const out = buildUserPlist({ ...CANONICAL_OPTS });
    matchFixture(USER_FIXTURE, out);
  });

  test('XML escapes user-controlled scalars round-trip', () => {
    const out = buildUserPlist({
      ...CANONICAL_OPTS,
      label: 'com.llamactl & <fun>',
    });
    expect(out).toContain('<string>com.llamactl &amp; &lt;fun&gt;</string>');
    // Raw special chars must not appear in the element content we
    // interpolated (the only `&` left is inside the escape sequences).
    expect(out).not.toContain('<string>com.llamactl & <fun></string>');
    // And of course no double-escape crept in.
    expect(out.includes('&amp;amp;')).toBe(false);
  });

  test('has no unresolved placeholders', () => {
    const out = buildUserPlist({ ...CANONICAL_OPTS });
    expect(/\{\{\w+\}\}/.test(out)).toBe(false);
  });
});

describe('buildSystemPlist', () => {
  test('byte-matches the system snapshot fixture', () => {
    const out = buildSystemPlist({ ...CANONICAL_SYSTEM_OPTS });
    matchFixture(SYSTEM_FIXTURE, out);
  });

  test('throws when system-only fields are missing', () => {
    expect(() => buildSystemPlist({ ...CANONICAL_OPTS })).toThrow(
      /requires user, group, and workingDir/,
    );
    expect(() =>
      buildSystemPlist({ ...CANONICAL_OPTS, user: 'alice', group: 'staff' }),
    ).toThrow(/requires user, group, and workingDir/);
  });

  test('contains UserName / GroupName / WorkingDirectory keys', () => {
    const out = buildSystemPlist({ ...CANONICAL_SYSTEM_OPTS });
    expect(out).toContain('<key>UserName</key><string>alice</string>');
    expect(out).toContain('<key>GroupName</key><string>staff</string>');
    expect(out).toContain(
      '<key>WorkingDirectory</key><string>/Users/alice/.llamactl-agent</string>',
    );
  });
});

describe('template constants', () => {
  test('user template does not contain system-only keys', () => {
    expect(LAUNCHD_USER_TEMPLATE.includes('UserName')).toBe(false);
    expect(LAUNCHD_USER_TEMPLATE.includes('GroupName')).toBe(false);
    expect(LAUNCHD_USER_TEMPLATE.includes('WorkingDirectory')).toBe(false);
  });

  test('system template contains exactly the three extra keys', () => {
    expect(LAUNCHD_SYSTEM_TEMPLATE.includes('<key>UserName</key>')).toBe(true);
    expect(LAUNCHD_SYSTEM_TEMPLATE.includes('<key>GroupName</key>')).toBe(true);
    expect(LAUNCHD_SYSTEM_TEMPLATE.includes('<key>WorkingDirectory</key>')).toBe(true);
  });
});

describe('plutil -lint', () => {
  // plutil is a macOS-only binary; skip gracefully on other platforms.
  const isDarwin = process.platform === 'darwin';

  function lint(body: string): { code: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-plist-lint-'));
    const file = join(dir, 'probe.plist');
    try {
      writeFileSync(file, body, 'utf8');
      const proc = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      return { code: proc.status ?? -1, stderr: proc.stderr ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.if(isDarwin)('user plist passes plutil -lint', () => {
    const body = buildUserPlist({ ...CANONICAL_OPTS });
    const res = lint(body);
    expect(res.code).toBe(0);
  });

  test.if(isDarwin)('system plist passes plutil -lint', () => {
    const body = buildSystemPlist({ ...CANONICAL_SYSTEM_OPTS });
    const res = lint(body);
    expect(res.code).toBe(0);
  });

  test.if(isDarwin)('XML-escaped plist passes plutil -lint', () => {
    const body = buildUserPlist({
      ...CANONICAL_OPTS,
      label: 'com.llamactl & <fun>',
    });
    const res = lint(body);
    expect(res.code).toBe(0);
    // The raw chars should be visible only as escapes in the rendered XML.
    expect(body).toContain('&amp;');
    expect(body).toContain('&lt;');
    expect(body).toContain('&gt;');
  });
});
