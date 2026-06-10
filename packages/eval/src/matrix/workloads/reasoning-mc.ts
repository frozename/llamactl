import type { WorkloadEval } from "../types.js";

/**
 * Reasoning A/B workload (MoQ vs Unsloth-Dynamic at matched BPW).
 *
 * Each suite is a separate workload sharing one factory so the matrix runs
 * them all against a single server boot per model (model-outer / workload-inner
 * loop). Scoring is exact-match -> use `primary_metric_name: 'mean_exact_match'`
 * so the runner means `metrics.exact_match` into a clean per-suite accuracy.
 *
 * Corpus row shape (see packages/eval/tools/fetch-reasoning-mc-corpus.py):
 *   mc:      { id, suite, kind: 'mc',      question, options: string[], answer: 'C' }
 *   numeric: { id, suite, kind: 'numeric', question,                    answer: '18' }
 */
export interface ReasoningRow {
  id: string;
  suite: string;
  kind: "mc" | "numeric";
  question: string;
  options?: string[];
  answer: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function buildUserMessage(r: ReasoningRow): string {
  if (r.kind === "mc") {
    const opts = (r.options ?? []).map((opt, i) => `${LETTERS[i] ?? ""}) ${opt}`).join("\n");
    return (
      `${r.question}\n\nOptions:\n${opts}\n\n` +
      `Reason briefly, then end with a single final line exactly:\nAnswer: <letter>`
    );
  }
  return (
    `${r.question}\n\n` +
    `Solve step by step, then end with a single final line exactly:\nAnswer: <number>`
  );
}

/** Last "Answer:" capture, else null. */
function lastAnswerLine(text: string): string | null {
  const re = /answer\s*[:=]\s*(.+)/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) {
    last = (m[1] ?? "").trim();
  }
  return last;
}

function normalizeNumber(raw: string): string | null {
  // keep the first signed decimal number in the fragment
  const m = /-?\d+(?:\.\d+)?/.exec(raw.replaceAll(",", ""));
  if (!m) return null;
  let n = m[0];
  if (n.includes(".")) n = n.replace(/0+$/, "").replace(/\.$/, ""); // 18.0 -> 18
  if (n === "-0") n = "0";
  return n;
}

function extractMc(completion: string, nOptions: number): string {
  const max = Math.max(1, Math.min(nOptions, LETTERS.length));
  const maxLetter = LETTERS[max - 1] ?? "A";
  const valid = new RegExp(`[A-${maxLetter}]`);
  const ans = lastAnswerLine(completion);
  if (ans) {
    const letter = /[A-Za-z]/.exec(ans);
    if (letter && valid.test(letter[0].toUpperCase())) return letter[0].toUpperCase();
  }
  // fallback: last standalone "(B)" / "B)" / "option B" / bare "B" in the tail
  const tail = completion.slice(-400);
  const re = /(?:\boption\s+|\(|\b)([A-Z])(?:\)|\b)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(tail)) !== null) {
    const c = (m[1] ?? "").toUpperCase();
    if (valid.test(c)) last = c;
  }
  return last ?? "__no_answer__";
}

function extractNumeric(completion: string): string {
  const ans = lastAnswerLine(completion);
  if (ans) {
    const n = normalizeNumber(ans);
    if (n !== null) return n;
  }
  // fallback: last number anywhere
  const all = completion.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/g);
  const last = all?.at(-1);
  if (last !== undefined) return normalizeNumber(last) ?? "__no_answer__";
  return "__no_answer__";
}

function numericEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

export function buildReasoningMcWorkload(opts: {
  name: string;
  corpus_path: string;
}): WorkloadEval {
  return {
    name: opts.name,
    corpus_path: opts.corpus_path,
    primary_metric_name: "mean_exact_match",
    // 1024 (was 768): the hard MMLU-Pro suite truncated ~13-15% of answers
    // before the final-answer line at 768 with reasoning-capable models, inflating
    // no_answer. 1024 leaves headroom for the chain-of-thought to land the answer.
    maxTokens: 1024,
    temperature: 0,
    prompt_builder: (row) => {
      const r = row as ReasoningRow;
      return {
        messages: [
          {
            role: "system",
            content:
              "You are a careful exam solver. Answer the question, then give the final answer on its own line.",
          },
          { role: "user", content: buildUserMessage(r) },
        ],
      };
    },
    scorer: (row, completion) => {
      const r = row as ReasoningRow;
      const gold = r.answer.trim();
      let prediction: string;
      let correct: boolean;
      if (r.kind === "mc") {
        prediction = extractMc(completion, (r.options ?? []).length);
        correct = prediction !== "__no_answer__" && prediction === gold.toUpperCase();
      } else {
        prediction = extractNumeric(completion);
        const goldNorm = normalizeNumber(gold) ?? gold;
        correct = prediction !== "__no_answer__" && numericEqual(prediction, goldNorm);
      }
      return {
        prediction,
        gold,
        metrics: {
          exact_match: correct ? 1 : 0,
          no_answer: prediction === "__no_answer__" ? 1 : 0,
        },
      };
    },
  };
}

const CORPUS_DIR = "packages/eval/corpora/reasoning-mc/v0";

export const reasoningMmluProWorkload = buildReasoningMcWorkload({
  name: "reasoning-mmlu-pro",
  corpus_path: `${CORPUS_DIR}/mmlu_pro.jsonl`,
});
export const reasoningGsm8kWorkload = buildReasoningMcWorkload({
  name: "reasoning-gsm8k",
  corpus_path: `${CORPUS_DIR}/gsm8k.jsonl`,
});
export const reasoningArcWorkload = buildReasoningMcWorkload({
  name: "reasoning-arc",
  corpus_path: `${CORPUS_DIR}/arc_challenge.jsonl`,
});
