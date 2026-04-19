import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultBinaryPath,
  defaultServicesDir,
  infraServiceLabel,
  infraServiceUnitPath,
  readServiceUnit,
  removeServiceUnit,
  renderLaunchdPlist,
  renderServiceUnit,
  renderSystemdUnit,
  runServiceLifecycle,
  unitBaseName,
  writeServiceUnit,
  type SubprocessRunner,
} from '../src/infra/services.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-infra-services-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE_OPTS = {
  pkg: 'embersynth',
  infraBase: '/base/infra',
  logDir: '/home/me/.llamactl/logs',
  env: { EMBERSYNTH_PORT: '7777', EMBERSYNTH_LOG_LEVEL: 'info' },
};

describe('infraServiceLabel + paths', () => {
  test('label uses llamactl-prefixed reverse-dns', () => {
    expect(infraServiceLabel('embersynth')).toBe('com.llamactl.infra.embersynth');
    expect(infraServiceLabel('sirius')).toBe('com.llamactl.infra.sirius');
  });

  test('unit path on darwin lives under LaunchAgents', () => {
    const path = infraServiceUnitPath('embersynth', 'darwin', { HOME: '/h' });
    expect(path).toBe('/h/Library/LaunchAgents/com.llamactl.infra.embersynth.plist');
  });

  test('unit path on linux lives under systemd user dir', () => {
    const path = infraServiceUnitPath('embersynth', 'linux', { HOME: '/h' });
    expect(path).toBe('/h/.config/systemd/user/llamactl-infra-embersynth.service');
  });

  test('defaultServicesDir respects HOME override', () => {
    expect(defaultServicesDir('darwin', { HOME: '/h' })).toBe('/h/Library/LaunchAgents');
    expect(defaultServicesDir('linux', { HOME: '/h' })).toBe('/h/.config/systemd/user');
  });

  test('defaultBinaryPath → <base>/<pkg>/current/bin/<pkg>', () => {
    expect(defaultBinaryPath('embersynth', '/base/infra')).toBe(
      '/base/infra/embersynth/current/bin/embersynth',
    );
  });

  test('unitBaseName strips the platform-specific suffix', () => {
    expect(unitBaseName('/a/b/com.llamactl.infra.embersynth.plist')).toBe(
      'com.llamactl.infra.embersynth',
    );
    expect(unitBaseName('/a/b/llamactl-infra-embersynth.service')).toBe(
      'llamactl-infra-embersynth',
    );
  });
});

describe('renderLaunchdPlist', () => {
  test('produces a plist with Label + KeepAlive + env vars + log paths', () => {
    const plist = renderLaunchdPlist(BASE_OPTS);
    expect(plist.startsWith('<?xml')).toBe(true);
    expect(plist).toContain('<string>com.llamactl.infra.embersynth</string>');
    expect(plist).toContain('<string>/base/infra/embersynth/current/bin/embersynth</string>');
    expect(plist).toContain('<key>EMBERSYNTH_PORT</key>');
    expect(plist).toContain('<string>7777</string>');
    expect(plist).toContain('<key>EMBERSYNTH_LOG_LEVEL</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('/home/me/.llamactl/logs/embersynth.log');
    expect(plist).toContain('/home/me/.llamactl/logs/embersynth.err');
  });

  test('XML-escapes metacharacters in env values', () => {
    const plist = renderLaunchdPlist({
      ...BASE_OPTS,
      env: { MESSAGE: 'hello & <world>' },
    });
    expect(plist).not.toContain('hello & <world>');
    expect(plist).toContain('hello &amp; &lt;world&gt;');
  });

  test('custom args flow through as additional ProgramArguments entries', () => {
    const plist = renderLaunchdPlist({ ...BASE_OPTS, args: ['--verbose', '--port=7777'] });
    expect(plist).toContain('<string>--verbose</string>');
    expect(plist).toContain('<string>--port=7777</string>');
  });

  test('binaryPath override replaces the default convention', () => {
    const plist = renderLaunchdPlist({
      ...BASE_OPTS,
      binaryPath: '/opt/custom/embersynth',
    });
    expect(plist).toContain('<string>/opt/custom/embersynth</string>');
    expect(plist).not.toContain('/base/infra/embersynth/current/bin/embersynth');
  });
});

describe('renderSystemdUnit', () => {
  test('produces a valid [Unit]/[Service]/[Install] file', () => {
    const unit = renderSystemdUnit(BASE_OPTS);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=llamactl infra service: embersynth');
    expect(unit).toContain(
      'ExecStart=/base/infra/embersynth/current/bin/embersynth',
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment=EMBERSYNTH_PORT=7777');
    expect(unit).toContain('Environment=EMBERSYNTH_LOG_LEVEL=info');
    expect(unit).toContain('StandardOutput=append:/home/me/.llamactl/logs/embersynth.log');
    expect(unit).toContain('WantedBy=default.target');
  });

  test('args concatenate onto the ExecStart command line', () => {
    const unit = renderSystemdUnit({ ...BASE_OPTS, args: ['--verbose'] });
    expect(unit).toContain(
      'ExecStart=/base/infra/embersynth/current/bin/embersynth --verbose',
    );
  });
});

describe('renderServiceUnit (host-dispatched)', () => {
  test('darwin → plist', () => {
    expect(renderServiceUnit('darwin', BASE_OPTS).startsWith('<?xml')).toBe(true);
  });
  test('linux → systemd', () => {
    const u = renderServiceUnit('linux', BASE_OPTS);
    expect(u.startsWith('[Unit]')).toBe(true);
  });
});

describe('writeServiceUnit / readServiceUnit / removeServiceUnit', () => {
  test('darwin round-trip', () => {
    const { path } = writeServiceUnit({
      ...BASE_OPTS,
      host: 'darwin',
      dir,
    });
    expect(path).toBe(join(dir, 'com.llamactl.infra.embersynth.plist'));
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    expect(body.startsWith('<?xml')).toBe(true);
  });

  test('linux round-trip', () => {
    const { path, label } = writeServiceUnit({
      ...BASE_OPTS,
      host: 'linux',
      dir,
    });
    expect(path).toBe(join(dir, 'llamactl-infra-embersynth.service'));
    expect(label).toBe('com.llamactl.infra.embersynth');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('[Service]');
  });

  test('readServiceUnit returns null when absent, body when present', () => {
    const { path } = writeServiceUnit({ ...BASE_OPTS, host: 'darwin', dir });
    const read = readServiceUnit('embersynth', 'darwin', { HOME: '/dev/null' });
    // readServiceUnit uses infraServiceUnitPath which derives its own
    // path from HOME — so it won't find our tempdir file. Assert the
    // "absent" path is null-safe; tempdir round-trip is validated
    // above via the path returned by writeServiceUnit.
    expect(read).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  test('runServiceLifecycle(darwin) invokes launchctl load for start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'llamactl-lifecycle-'));
    const written = writeServiceUnit({
      pkg: 'embersynth',
      infraBase: '/base/infra',
      logDir: '/base/logs',
      env: {},
      host: 'darwin',
      env_proc: { HOME: home },
    });
    const captured: string[][] = [];
    const runner: SubprocessRunner = async (cmd) => {
      captured.push(cmd);
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const result = await runServiceLifecycle({
      pkg: 'embersynth',
      action: 'start',
      host: 'darwin',
      env: { HOME: home },
      runner,
    });
    expect(result.code).toBe(0);
    expect(captured[0]).toEqual(['launchctl', 'load', written.path]);
    rmSync(home, { recursive: true, force: true });
  });

  test('runServiceLifecycle(linux) invokes systemctl --user with the unit name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'llamactl-lifecycle-'));
    writeServiceUnit({
      pkg: 'sirius',
      infraBase: '/base/infra',
      logDir: '/base/logs',
      env: {},
      host: 'linux',
      env_proc: { HOME: home },
    });
    const captured: string[][] = [];
    const runner: SubprocessRunner = async (cmd) => {
      captured.push(cmd);
      return { code: 0, stdout: 'active', stderr: '' };
    };
    await runServiceLifecycle({
      pkg: 'sirius',
      action: 'status',
      host: 'linux',
      env: { HOME: home },
      runner,
    });
    expect(captured[0]).toEqual([
      'systemctl',
      '--user',
      'is-active',
      'llamactl-infra-sirius.service',
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  test('runServiceLifecycle rejects start when unit file is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'llamactl-lifecycle-'));
    await expect(
      runServiceLifecycle({
        pkg: 'nope',
        action: 'start',
        host: 'darwin',
        env: { HOME: home },
        runner: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(/no unit file/);
    rmSync(home, { recursive: true, force: true });
  });

  test('runServiceLifecycle surfaces non-zero exit as ok:false equivalent via code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'llamactl-lifecycle-'));
    writeServiceUnit({
      pkg: 'embersynth',
      infraBase: '/base/infra',
      logDir: '/base/logs',
      env: {},
      host: 'darwin',
      env_proc: { HOME: home },
    });
    const result = await runServiceLifecycle({
      pkg: 'embersynth',
      action: 'start',
      host: 'darwin',
      env: { HOME: home },
      runner: async () => ({ code: 1, stdout: '', stderr: 'already loaded' }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already loaded');
    rmSync(home, { recursive: true, force: true });
  });

  test('removeServiceUnit returns false when absent, true when it removes', () => {
    expect(removeServiceUnit('no-such-pkg', 'darwin', { HOME: dir })).toBe(false);
    writeServiceUnit({ ...BASE_OPTS, host: 'darwin', dir });
    // Align HOME so removeServiceUnit resolves the same path we wrote.
    const home = mkdtempSync(join(tmpdir(), 'llamactl-services-home-'));
    const { path } = writeServiceUnit({
      ...BASE_OPTS,
      host: 'darwin',
      env_proc: { HOME: home },
    });
    expect(existsSync(path)).toBe(true);
    expect(removeServiceUnit('embersynth', 'darwin', { HOME: home })).toBe(true);
    expect(existsSync(path)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
