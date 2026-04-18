import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface CertFiles {
  certPath: string;
  keyPath: string;
}

export interface GeneratedCert extends CertFiles {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

export async function generateSelfSignedCert(opts: {
  dir: string;
  commonName: string;
  daysValid?: number;
  /** DNS names and/or IP literals to include as SubjectAltName entries. */
  hostnames?: string[];
}): Promise<GeneratedCert> {
  const { dir, commonName, daysValid = 36500, hostnames } = opts;
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'agent.crt');
  const keyPath = join(dir, 'agent.key');
  // ECDSA P-256 (prime256v1). Bun's TLS stack rejects ed25519 server
  // certs with "sslv3 alert handshake failure" as of Bun 1.3.x; RSA and
  // ECDSA both work. P-256 is modern, compact, and universally supported.
  await runOpenssl([
    'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath,
  ]);
  const sans = (hostnames && hostnames.length > 0 ? hostnames : [commonName])
    .map((h) => (isIPv4(h) || isIPv6(h) ? `IP:${h}` : `DNS:${h}`))
    .join(',');
  await runOpenssl([
    'req', '-x509', '-key', keyPath,
    '-out', certPath,
    '-days', String(daysValid),
    '-subj', `/CN=${commonName}`,
    '-addext', `subjectAltName=${sans}`,
  ]);
  chmodSync(keyPath, 0o600);
  const certPem = readFileSync(certPath, 'utf8');
  const keyPem = readFileSync(keyPath, 'utf8');
  const fingerprint = computeFingerprint(certPem);
  return { certPath, keyPath, certPem, keyPem, fingerprint };
}

export function loadCert(files: CertFiles): { certPem: string; keyPem: string; fingerprint: string } {
  if (!existsSync(files.certPath)) throw new Error(`cert not found: ${files.certPath}`);
  if (!existsSync(files.keyPath)) throw new Error(`key not found: ${files.keyPath}`);
  const certPem = readFileSync(files.certPath, 'utf8');
  const keyPem = readFileSync(files.keyPath, 'utf8');
  return { certPem, keyPem, fingerprint: computeFingerprint(certPem) };
}

export function computeFingerprint(certPem: string): string {
  const match = certPem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!match || !match[1]) throw new Error('not a valid cert PEM');
  const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  const hex = createHash('sha256').update(der).digest('hex');
  return `sha256:${hex}`;
}

export function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isIPv4(h: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(h);
}

function isIPv6(h: string): boolean {
  // Require both hex-only chars AND at least one colon to avoid
  // mislabeling plain-hex hostnames like 'cafe' or 'abc' as IPs.
  return h.includes(':') && /^[0-9a-fA-F:]+$/.test(h);
}

function runOpenssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`openssl ${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export { writeFileSync as __writeForTest };
