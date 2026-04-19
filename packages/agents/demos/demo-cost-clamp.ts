/**
 * demo-cost-clamp — N.5 golden-path demo. Drives three cost-guardian
 * ticks with progressively higher simulated spend against a tight
 * $10/day budget, demonstrating the tier transition noop → warn →
 * force_private that the guardian records to its journal.
 *
 * Run with:
 *   bun run packages/agents/demos/demo-cost-clamp.ts
 *
 * Uses a fake RunbookToolClient so no network, no fs writes outside
 * a tempdir, no real usage corpus needed.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCostGuardianTick } from '../src/cost-guardian/tick.js';
import type { CostGuardianConfig } from '../src/cost-guardian/config.js';
import type { RunbookToolClient, ToolCallInput } from '../src/types.js';

const NARRATIVE = `\
N.5 golden-path demo — cost-clamp (guardian tier escalation)
============================================================

What you're watching: the cost-guardian's pure decision engine
reacting to a rising daily spend. Same code a real 'llamactl
cost-guardian tick' invocation runs, but the nova.ops.cost.snapshot
tool is faked so we can dial the dollar figure between ticks.

Budget: $10/day  (thresholds: warn 50%, force_private 80%, deregister 95%)

Tick 1 — spend $2  (20%): tier = noop
Tick 2 — spend $6  (60%): tier = warn
Tick 3 — spend $8.50 (85%): tier = force_private
`;

function banner(text: string): void {
  process.stdout.write(`\n─── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}\n`);
}

/**
 * Fake MCP client — every `nova.ops.cost.snapshot` call returns a
 * deterministic daily/weekly envelope with the currently-staged total
 * cost. Mirrors the `{content: [{type, text}]}` shape `parseToolJson`
 * expects.
 */
function fakeToolClient(stage: { dailyUsd: number; weeklyUsd: number }): RunbookToolClient {
  return {
    async callTool(input: ToolCallInput): Promise<unknown> {
      if (input.name === 'nova.ops.cost.snapshot') {
        const days = Number((input.arguments as { days?: number }).days ?? 1);
        const total = days === 1 ? stage.dailyUsd : stage.weeklyUsd;
        const now = new Date();
        const payload = {
          totalEstimatedCostUsd: total,
          windowSince: new Date(now.getTime() - days * 86_400_000).toISOString(),
          windowUntil: now.toISOString(),
          byProvider: [{ key: 'openai', estimatedCostUsd: total }],
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }
      if (input.name === 'llamactl.embersynth.set-default-profile') {
        // Tier-2 effect: guardian asks llamactl to remap the default
        // synthetic model to private-first. Return a success shape
        // the tick handler expects.
        const args = input.arguments as { profile?: string; syntheticModel?: string };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                profile: args.profile ?? 'private-first',
                syntheticModel: args.syntheticModel ?? 'fusion-auto',
                path: '<demo>/embersynth.yaml',
                previous: 'auto',
                next: args.profile ?? 'private-first',
              }),
            },
          ],
        };
      }
      throw new Error(`demo-cost-clamp: unexpected tool call ${input.name}`);
    },
  };
}

async function main(): Promise<void> {
  process.stdout.write(NARRATIVE);

  const runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-cost-clamp-'));
  const journalPath = join(runtimeDir, 'cost-journal.jsonl');
  banner('Fleet seeded');
  process.stdout.write(`  journal: ${journalPath}\n`);

  const config: CostGuardianConfig = {
    budget: { daily_usd: 10, weekly_usd: 60 },
    thresholds: { warn: 0.5, force_private: 0.8, deregister: 0.95 },
    // auto_force_private flips on so tier-2 actually invokes the
    // embersynth.set-default-profile mutation during tick 3.
    auto_force_private: true,
    auto_deregister: false,
  };

  const scenarios = [
    { label: 'Tick 1 (20% spend)', dailyUsd: 2, weeklyUsd: 12 },
    { label: 'Tick 2 (60% spend)', dailyUsd: 6, weeklyUsd: 36 },
    { label: 'Tick 3 (85% spend)', dailyUsd: 8.5, weeklyUsd: 48 },
  ];

  try {
    for (const s of scenarios) {
      banner(s.label);
      const decision = await runCostGuardianTick({
        tools: fakeToolClient({ dailyUsd: s.dailyUsd, weeklyUsd: s.weeklyUsd }),
        config,
        journalPath,
        disableWebhook: true,
      });
      process.stdout.write(
        `  daily=$${s.dailyUsd.toFixed(2)}  weekly=$${s.weeklyUsd.toFixed(2)}  tier=${decision.tier}\n`,
      );
      process.stdout.write(`  reason: ${decision.reason}\n`);
    }

    banner('Journal entries');
    const raw = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
    const entries = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; decision?: { tier?: string; reason?: string } });
    for (const e of entries) {
      if (e.kind === 'tick') {
        const d = e.decision;
        process.stdout.write(
          `  tick: tier=${d?.tier ?? '?'}  reason=${d?.reason ?? '?'}\n`,
        );
      } else {
        process.stdout.write(`  ${e.kind}: ${JSON.stringify(e)}\n`);
      }
    }

    banner('Result');
    const tiers = entries
      .filter((e) => e.kind === 'tick')
      .map((e) => e.decision?.tier ?? '');
    const ok =
      tiers.length === 3 &&
      tiers[0] === 'noop' &&
      tiers[1] === 'warn' &&
      tiers[2] === 'force_private';
    process.stdout.write(`  tier progression: ${tiers.join(' → ')}\n`);
    process.stdout.write(`  ok=${ok}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    banner('Teardown complete');
  }
}

main().catch((err) => {
  console.error('demo-cost-clamp crashed:', err);
  process.exitCode = 1;
});
