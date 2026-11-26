import { type ComponentProps, memo } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import type { ChatProgress } from "../chat-client";

const languageLabels = new Map([
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["cs", "C#"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["html", "HTML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["js", "JavaScript"],
  ["json", "JSON"],
  ["jsx", "JSX"],
  ["md", "Markdown"],
  ["plaintext", "Text"],
  ["py", "Python"],
  ["python", "Python"],
  ["rs", "Rust"],
  ["rust", "Rust"],
  ["sh", "Shell"],
  ["shell", "Shell"],
  ["sql", "SQL"],
  ["text", "Text"],
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["txt", "Text"],
  ["typescript", "TypeScript"],
  ["xml", "XML"],
  ["yaml", "YAML"],
  ["yml", "YAML"],
]);

type CodeBlockProps = ComponentProps<"pre"> & { node?: ExtraProps["node"] };

function CodeBlock({ node, ...props }: CodeBlockProps): React.JSX.Element {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code?.type === "element" ? code.properties.className : undefined;
  const language = Array.isArray(classes)
    ? classes.find(
        (value): value is string => typeof value === "string" && value.startsWith("language-"),
      )
    : undefined;
  const tag = language?.slice("language-".length) ?? "text";
  return (
    <figure className="chat-code-block">
      <figcaption>{languageLabels.get(tag.toLowerCase()) ?? tag}</figcaption>
      <pre {...props} tabIndex={0} />
    </figure>
  );
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  pre: CodeBlock,
};

const MarkdownText = memo(function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { plainText: ["text", "txt", "plaintext"] }]]}
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
