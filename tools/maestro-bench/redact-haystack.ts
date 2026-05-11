// Standalone redactor adapter: reads {text, knownAgents} JSON on stdin,
// runs penumbra's MaestroOutputRedactor over the text, writes {decision,
// content, hits} JSON on stdout. The bench harness shells out here when
// invoked with --redact-via penumbra.
import { MaestroOutputRedactor } from '../../../penumbra/packages/agentchat/src/worker/maestro-output-redactor.ts';

type Input = { text: string; knownAgents?: string[] };

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as Input;
const redactor = new MaestroOutputRedactor({
  knownAgents: new Set(input.knownAgents ?? []),
  bypass: false,
});
const result = redactor.checkContent(input.text ?? '');
process.stdout.write(
  JSON.stringify({
    decision: result.decision,
    content: result.content,
    hits: result.hits,
  }),
);
