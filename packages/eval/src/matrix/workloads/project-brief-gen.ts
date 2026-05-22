import type { WorkloadEval } from '../types.js';

interface Memory {
  memory_id: string;
  title: string;
  body: string;
  obs_type: string;
  created_at: string;
}

interface CorpusRow {
  id: string;
  project_id: string;
  window_start: string;
  window_end: string;
  memories: Memory[];
}

const SYSTEM_PROMPT = `You are a project historian synthesizing recent activity into a structured project brief.

Given a set of recent project memories, write a multi-paragraph markdown document covering:
- What was built, fixed, or decided
- Open threads and unresolved questions
- Key decisions and their rationale
- Recommended follow-ups

Format your response as structured markdown. Use ## section headers to separate distinct themes. Write in a neutral, factual style. Be specific — name the things that were done, not just that work happened.`;

function buildUserMessage(row: CorpusRow): string {
  const entries = row.memories
    .map((m, i) => `${i + 1}. **${m.title}** (${m.created_at.slice(0, 10)})\n${m.body}`)
    .join('\n\n');
  return `Project: ${row.project_id} | Period: ${row.window_start} to ${row.window_end}\n\nRecent memories:\n\n${entries}\n\nWrite a project brief covering the above activity.`;
}

function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

function countSections(text: string): number {
  return (text.match(/^## /gm) ?? []).length;
}

function countParagraphs(text: string): number {
  return text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
}

export const projectBriefGenWorkload: WorkloadEval = {
  name: 'project-brief-gen',
  corpus_path: 'packages/eval/corpora/project-brief-gen/v0/test.jsonl',
  primary_metric_name: 'mean_brief_quality',
  maxTokens: 2048,
  temperature: 0.3,
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(r) },
      ],
    };
  },
  scorer: (_row, completion) => {
    const tokens = estimateTokens(completion);
    const sections = countSections(completion);
    const paragraphs = countParagraphs(completion);

    let token_count_score: number;
    if (tokens >= 1200 && tokens <= 2400) {
      token_count_score = 1.0;
    } else if (tokens < 1200) {
      token_count_score = tokens / 1200;
    } else {
      token_count_score = Math.max(0, 1 - (tokens - 2400) / 2400);
    }

    const structure_score = sections >= 3 ? 1.0 : sections === 2 ? 0.5 : 0;
    const paragraph_score = paragraphs >= 4 ? 1.0 : paragraphs === 3 ? 0.5 : 0;
    const brief_quality = (token_count_score + structure_score + paragraph_score) / 3;

    return {
      metrics: {
        token_count_score,
        structure_score,
        paragraph_score,
        brief_quality,
        estimated_tokens: tokens,
        section_count: sections,
        paragraph_count: paragraphs,
      },
      prediction: `tokens=${tokens} sections=${sections} paragraphs=${paragraphs}`,
      gold: 'n/a',
    };
  },
};
