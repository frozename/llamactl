import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChatProgress } from "../chat-client";

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

const MarkdownText = memo(function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </Markdown>
    </div>
  );
});

function GenerationStats({ progress }: { progress: ChatProgress }): React.JSX.Element {
  const { rate, outputTokens } = progress;
  return (
    <div className="chat-metrics" aria-label="Generation statistics">
      {rate === undefined ? null : (
        <span
          className="chat-metric"
          title={
            rate.source === "engine"
              ? "Engine-reported decode rate"
              : "Approximate rate measured across streamed output in this browser"
          }
        >
          {rate.source === "stream" ? "≈" : ""}
          {rate.value.toFixed(1)} tok/s
        </span>
      )}
      {outputTokens === undefined ? null : (
        <span className="chat-metric">{outputTokens} tokens</span>
      )}
    </div>
  );
}

export function ChatReply({
  reply,
  model,
  pending,
  stopped,
}: {
  reply: ChatProgress;
  model: string;
  pending: boolean;
  stopped: boolean;
}): React.JSX.Element {
  const { reasoning, reasoningTokens } = reply;
  const thinking = pending && Boolean(reasoning) && !reply.reply;
  return (
    <div className="chat-reply">
      <div className="chat-reply-heading">
        <span className="chat-speaker">{model}</span>
        <GenerationStats progress={reply} />
      </div>
      {reasoning ? (
        <details className="chat-thinking" open={thinking}>
          <summary>
            <span>{thinking ? "Thinking…" : "Thinking"}</span>
            {reasoningTokens === undefined ? null : (
              <span className="chat-metric">{reasoningTokens} tokens</span>
            )}
          </summary>
          <MarkdownText text={reasoning} />
        </details>
      ) : null}
      {reply.reply ? <MarkdownText text={reply.reply} /> : null}
      {pending && !reply.reply && !reasoning ? <p role="status">Waiting for a reply…</p> : null}
      {stopped ? <span className="chat-speaker">Stopped</span> : null}
    </div>
  );
}
