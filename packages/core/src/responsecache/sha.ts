import { createHash } from 'node:crypto';

export function canonicalRequestSha(body: string | Uint8Array): string {
  const rawBytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    const canonical = JSON.stringify(sortJsonValue(parsed));
    return createHash('sha1').update(canonical).digest('hex');
  } catch {
    return createHash('sha1').update(rawBytes).digest('hex');
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}
