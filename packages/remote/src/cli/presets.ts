/**
 * Known CLI presets — canned `{command, args, format}` templates for
 * the CLIs llamactl knows how to drive today. Each preset declares:
 *
 *   - `command`: the binary name we spawn (resolved via the
 *     subprocess's `$PATH`, NOT invoked through a shell).
 *   - `args`: argv template with `{{prompt}}` placeholder. The
 *     adapter substitutes the serialized prompt at call time; any
 *     other `{{key}}` placeholders stay as literals.
 *   - `format`: how to parse stdout. `'text'` = raw assistant
 *     content; `'json'` = best-effort structured envelope (only
 *     used by presets that emit machine-readable output; v1 all
 *     presets default to text).
 *
 * Adding a preset: append to `CLI_PRESETS` + extend the
 * `CliPresetSchema` enum in `config/schema.ts`. Nothing else.
 * Custom CLIs that don't fit a preset use `preset: 'custom'` with
 * operator-supplied `command` + `args`.
 */
import type { CliBinding, CliPreset } from '../config/schema.js';

export interface ResolvedCliInvocation {
  command: string;
  args: string[];
  format: 'text' | 'json';
  /**
   * True when the preset emits output progressively and the
   * adapter should expose a streaming `streamResponse`. False =
   * the CLI only prints at completion; `streamResponse` falls
   * back to collecting the full output and yielding one chunk.
   * Phase 5 enables streaming for the `claude` preset only;
   * codex + gemini stay false.
   */
  stream: boolean;
  /**
   * The preset's declared version probe — a short argv vector that
   * should exit 0 on a working install (and reveal "not logged in"
   * or "missing binary" cleanly). `cliDoctor` uses this.
   */
  versionProbe: string[];
}

interface PresetDef {
  command: string;
  args: string[];
  format: 'text' | 'json';
  stream: boolean;
  versionProbe: string[];
}

/**
 * Preset defaults. Operators can override `command` + `args` per
 * binding to pin a specific argv shape (e.g. point at a particular
 * claude binary path); the preset just seeds the starting point.
 *
 * The `{{prompt}}` placeholder MUST appear exactly once in `args` —
 * the adapter's template expander replaces the first occurrence with
 * the serialized prompt and leaves the rest untouched. Presets that
 * read the prompt from stdin instead can set `args` without the
 * placeholder; the adapter falls back to piping on stdin when it
 * sees no `{{prompt}}` token.
 */
export const CLI_PRESETS: Record<Exclude<CliPreset, 'custom'>, PresetDef> = {
  claude: {
    command: 'claude',
    args: ['-p', '{{prompt}}', '--output-format', 'text'],
    format: 'text',
    // `claude -p` prints tokens as they arrive when stdout is a
    // pipe — the adapter line-buffers stdout and forwards each
    // line as a streaming chunk so CLI-backed chat feels
    // interactive, not batch.
    stream: true,
    versionProbe: ['--version'],
  },
  codex: {
    command: 'codex',
    args: ['exec', '{{prompt}}'],
    format: 'text',
    stream: false,
    versionProbe: ['--version'],
  },
  gemini: {
    command: 'gemini',
    args: ['-p', '{{prompt}}'],
    format: 'text',
    stream: false,
    versionProbe: ['--version'],
  },
};

/**
 * Merge a binding's preset defaults with its operator overrides.
 * `preset: 'custom'` requires both `command` and `args` on the
 * binding — throws otherwise so the misconfiguration surfaces at
 * adapter-construction time, not on first call.
 */
export function resolvePreset(binding: CliBinding): ResolvedCliInvocation {
  if (binding.preset === 'custom') {
    if (!binding.command || !binding.args) {
      throw new Error(
        `cli binding '${binding.name}': preset='custom' requires command and args`,
      );
    }
    return {
      command: binding.command,
      args: [...binding.args],
      format: binding.format,
      // Custom presets default to non-streaming — operators who
      // know their CLI streams can wrap it in a fork of the
      // adapter; the default stays conservative.
      stream: false,
      versionProbe: ['--version'],
    };
  }
  const preset = CLI_PRESETS[binding.preset];
  return {
    command: binding.command ?? preset.command,
    args: binding.args ? [...binding.args] : [...preset.args],
    format: binding.format ?? preset.format,
    stream: preset.stream,
    versionProbe: preset.versionProbe,
  };
}

/**
 * Substitute `{{prompt}}` (and optionally future placeholders) in an
 * argv array. Exported for adapter + tests. Returns a new array;
 * inputs are not mutated.
 *
 * If `{{prompt}}` isn't present the prompt will be sent via stdin —
 * adapters detect this and route accordingly.
 */
export function expandArgs(args: string[], prompt: string): {
  args: string[];
  promptOnStdin: boolean;
} {
  let substituted = false;
  const out = args.map((a) => {
    if (!a.includes('{{prompt}}')) return a;
    substituted = true;
    return a.replace('{{prompt}}', prompt);
  });
  return { args: out, promptOnStdin: !substituted };
}
