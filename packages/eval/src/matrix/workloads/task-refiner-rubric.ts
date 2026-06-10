import type { WorkloadEval } from "../types.js";

interface CorpusRow {
  handoff_id?: string;
  to_agent?: string;
  input: string;
}

const REFINER_SYSTEM_PROMPT = `You receive a draft DISPATCH PROMPT meant for an autonomous coding agent (ACP). Your job is to reshape it so the agent does not misread it as session-bootstrap context, brainstorming material, or a request for approval.

Required output shape:
1. First sentence: imperative verb + the task in <=20 words. Examples: "Implement X.", "Spike Y end-to-end.", "Investigate Z and report findings."
2. Then 1-3 sentences of constraint: deliverable, what is in scope, what 'done' looks like.
3. If the input contains design / plan / proposal / "approved" framing, append exactly: "Design approved — execute end-to-end without proposing or asking for sign-off."
4. Then a single \`Context:\` paragraph (NOT a markdown heading) carrying the substantive context. Drop preamble, TOC framing, meta narration.

Strictly forbidden in output:
- Top-level markdown headers (lines starting with # or ##)
- Phrases like "Here is the task", "Below is", "I would like you to"
- Any content that reads as a document index or session bootstrap

Return ONLY the reshaped prompt. No preamble. No "Refined prompt:" prefix.`;

const JUDGE_SYSTEM = `You are a strict rubric judge for dispatch-prompt refiners. You receive the ORIGINAL draft prompt and a CANDIDATE refined output. Score the candidate on three dimensions, each 0-3:

intent_preservation: does the refined output preserve the original task intent and deliverable? (0=lost, 1=partial, 2=mostly, 3=fully preserved)
contract_clarity:    is the deliverable / scope / 'done' criterion sharper in the candidate than the input? (0=worse, 1=same, 2=better, 3=clearly sharper with explicit done-criterion)
noise_removal:       does the candidate strip preamble, meta-narration, approval-seeking, TOC framing? (0=none removed, 1=partial, 2=most, 3=clean)

Reply with JSON only, no preamble, no markdown:
{"intent_preservation": <0-3>, "contract_clarity": <0-3>, "noise_removal": <0-3>, "comment": "<one sentence>"}`;

const judgeModel = {
  name: "judge-granite-8b-Q4",
  gguf_path:
    "/Volumes/WorkSSD/ai-models/llama.cpp/models/granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf",
  quant: "Q4_K_M",
  family: "granite-4.1",
  size_params: "8B",
  host: "127.0.0.1",
  port: 8094,
  extra_args: [],
  binary: "/Users/acordeiro/DevStorage/src/llama.cpp/build/bin/llama-server",
  start_args: [
    "--ctx-size",
    "16384",
    "-ngl",
    "999",
    "--flash-attn",
    "on",
    "-ctk",
    "q8_0",
    "-ctv",
    "q8_0",
    "--no-warmup",
    "-np",
    "1",
    "--jinja",
    "--reasoning",
    "off",
    "--alias",
    "local",
  ],
  managed: true,
} as const;

function parseJudgeJson(
  text: string,
): { intent_preservation: number; contract_clarity: number; noise_removal: number } | null {
  let s = text;
  if (s.includes("@@metadata")) {
    const parts = s.split("@@metadata", 2);
    if (parts.length > 1) s = parts[1] ?? "";
    const endParts = s.split("@@end", 1);
    if (endParts.length > 0) s = endParts[0] ?? "";
  }
  const fenceStart = s.indexOf("```");
  const fenceEnd = fenceStart >= 0 ? s.indexOf("```", fenceStart + 3) : -1;
  if (fenceStart >= 0 && fenceEnd > fenceStart) {
    const fenced = s.slice(fenceStart + 3, fenceEnd).trim();
    s = fenced.startsWith("json") ? fenced.slice(4).trim() : fenced;
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const out: { intent_preservation: number; contract_clarity: number; noise_removal: number } = {
      intent_preservation: 0,
      contract_clarity: 0,
      noise_removal: 0,
    };
    for (const k of ["intent_preservation", "contract_clarity", "noise_removal"] as const) {
      const v = obj[k];
      if (typeof v !== "number" || v < 0 || v > 3) return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export const taskRefinerRubricWorkload: WorkloadEval = {
  name: "task-refiner-rubric",
  corpus_path: "/tmp/phase2-refiner/inputs.jsonl",
  primary_metric_name: "composite",
  judge_model: judgeModel,
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return {
      messages: [
        { role: "system", content: REFINER_SYSTEM_PROMPT },
        { role: "user", content: r.input },
      ],
    };
  },
  scorer: async (row, completion) => {
    const r = row as CorpusRow;
    const fail = (reason: string) => ({
      metrics: {
        intent_preservation: 0,
        contract_clarity: 0,
        noise_removal: 0,
        composite: 0,
        parse_error: 1,
      },
      prediction: reason,
      gold: "judged",
    });
    if (!completion.trim()) return fail("empty_output");
    const judgeReq = {
      model: "local",
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `ORIGINAL:\n${r.input}\n\nCANDIDATE:\n${completion}` },
      ],
      max_tokens: 300,
      temperature: 0,
    };
    const judgeUrl = `http://${judgeModel.host}:${String(judgeModel.port)}/v1/chat/completions`;
    let judgeText: string;
    try {
      const resp = await fetch(judgeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(judgeReq),
      });
      if (!resp.ok) return fail(`judge_http_${String(resp.status)}`);
      const j = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      judgeText = j.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      return fail(`judge_fetch_${err instanceof Error ? err.message : "unknown"}`);
    }
    const parsed = parseJudgeJson(judgeText);
    if (!parsed) return fail("judge_parse_error");
    const intent = parsed.intent_preservation;
    const contract = parsed.contract_clarity;
    const noise = parsed.noise_removal;
    const composite = (intent + contract + noise) / 9.0;
    return {
      metrics: {
        intent_preservation: intent,
        contract_clarity: contract,
        noise_removal: noise,
        composite,
      },
      prediction: "judged",
      gold: "judged",
    };
  },
};
