export type RedactResult = {
  value: unknown;
  redacted?: 'omitted' | 'truncated';
};

type Rule = (input: unknown) => RedactResult;

const TRUNCATE_AT = 4096;

const RULES: Record<string, Rule> = {
  'llamactl.secrets.read': () => ({ value: undefined, redacted: 'omitted' }),
  'llamactl.fs.read': (input) => {
    const json = JSON.stringify(input ?? null);
    if (json.length <= TRUNCATE_AT) return { value: input };
    const head = json.slice(0, TRUNCATE_AT);
    return {
      value: { _truncated: true, preview: head },
      redacted: 'truncated',
    };
  },
};

export function redactResult(toolName: string, input: unknown): RedactResult {
  const rule = RULES[toolName];
  if (rule) return rule(input);
  return { value: input };
}
