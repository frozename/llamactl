import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadEval } from "../types.js";

interface HumanEvalRow {
  task_id: string;
  prompt: string;
  canonical_solution: string;
  test: string;
  entry_point: string;
}

const RELIABILITY_GUARD = `import os
os.environ["OMP_NUM_THREADS"] = "1"
import builtins
import shutil
import subprocess
os.kill = None
os.system = None
os.remove = None
os.removedirs = None
os.rmdir = None
os.unlink = None
shutil.rmtree = None
subprocess.Popen = None
builtins.help = None
builtins.quit = None
builtins.exit = None
`;

function extractFencedCode(completion: string): string | null {
  const pythonFence = /```(?:python|py)[^\n]*\n([\s\S]*?)```/i.exec(completion);
  if (pythonFence) return pythonFence[1] ?? "";
  const genericFence = /```[^\n]*\n([\s\S]*?)```/.exec(completion);
  return genericFence ? (genericFence[1] ?? "") : null;
}

function stderrTail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(-2000);
}

export function extractCode(completion: string, entryPoint: string, promptSource: string): string {
  const extracted = extractFencedCode(completion) ?? completion;
  if (extracted.includes(`def ${entryPoint}`)) {
    return extracted;
  }
  return `${promptSource}${extracted}`;
}

export function buildProgram(
  candidateSource: string,
  testSource: string,
  entryPoint: string,
): string {
  return `${RELIABILITY_GUARD}\n${candidateSource}\n\n${testSource}\n\ncheck(${entryPoint})\n`;
}

export async function runCandidate(
  program: string,
  opts?: { timeoutMs?: number },
): Promise<{ passed: boolean; status: "pass" | "fail" | "timeout" | "error"; detail?: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "llamactl-humaneval-"));
  try {
    const file = join(tmpDir, "candidate.py");
    writeFileSync(file, program, "utf8");
    const proc = Bun.spawn(["python3", "-I", file], {
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs ?? 10000,
      killSignal: "SIGKILL",
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) {
      return { passed: true, status: "pass" };
    }
    if (proc.signalCode !== null) {
      return { passed: false, status: "timeout", detail: stderrTail(stderr) };
    }
    return { passed: false, status: "fail", detail: stderrTail(stderr) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { passed: false, status: "error", detail };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export const codeHumanevalWorkload: WorkloadEval = {
  name: "code-humaneval",
  corpus_path: "packages/eval/corpora/code-humaneval/v0/test.jsonl",
  primary_metric_name: "mean_pass_at_1",
  maxTokens: 768,
  temperature: 0,
  prompt_builder: (row) => {
    const r = row as HumanEvalRow;
    return {
      messages: [
        {
          role: "system",
          content:
            "You are an expert Python programmer. Complete the given function. Respond with the complete Python function inside a single ```python code block and nothing else.",
        },
        { role: "user", content: `Complete this Python function:\n\n${r.prompt}` },
      ],
    };
  },
  scorer: async (row, completion) => {
    const r = row as HumanEvalRow;
    const code = extractCode(completion, r.entry_point, r.prompt);
    const program = buildProgram(code, r.test, r.entry_point);
    const result = await runCandidate(program);
    return {
      prediction: result.status,
      gold: "pass",
      metrics: { pass: result.passed ? 1 : 0 },
    };
  },
};
