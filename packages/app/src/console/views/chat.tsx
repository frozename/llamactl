import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { saveBrowserRequest } from "../browser-requests";
import { type ChatMessage, type ChatProgress, loadChatModels, streamChat } from "../chat-client";
import { ChatReply } from "./chat-reply";
import "./chat.css";

interface ChatTurn extends ChatProgress {
  prompt: string;
  model: string;
  stopped?: boolean;
}

function ChatTranscript({
  turns,
  pending,
}: {
  turns: ChatTurn[];
  pending: ChatTurn | null;
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const keepInView = useRef(true);
  useEffect(() => {
    const element = panel.current;
    if (element && keepInView.current) element.scrollTop = element.scrollHeight;
  }, [turns, pending]);
  return (
    <div
      ref={panel}
      className="chat-transcript"
      aria-label="Conversation"
      onScroll={(event) => {
        const element = event.currentTarget;
        keepInView.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {turns.length === 0 && pending === null ? (
        <div className="chat-empty">
          <h2>Start a conversation</h2>
          <p>Choose a model and send a message.</p>
        </div>
      ) : null}
      {[...turns, ...(pending ? [pending] : [])].map((turn, index) => (
        <div key={index} className="chat-turn">
          <div className="chat-prompt">
            <span className="chat-speaker">You</span>
            <p>{turn.prompt}</p>
          </div>
          <ChatReply
            reply={turn}
            model={turn.model}
            pending={turn === pending}
            stopped={turn.stopped === true}
          />
        </div>
      ))}
    </div>
  );
}

interface ChatConversation {
  draft: string;
  setDraft: (draft: string) => void;
  turns: ChatTurn[];
  pending: ChatTurn | null;
  notice: string | null;
  send: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

interface ActiveRequest {
  id: string;
  node: string;
  at: number;
  started: number;
  firstByteMs: number | null;
  status: number;
  controller: AbortController;
  messages: ChatMessage[];
  turn: ChatTurn;
}

function saveRequest(request: ActiveRequest, failure: unknown): void {
  const { id, node, at, started, firstByteMs, status, turn, controller, messages } = request;
  saveBrowserRequest({
    id,
    node,
    at,
    path: "/v1/chat/completions",
    model: turn.model,
    status,
    firstByteMs,
    durationMs: Math.round(performance.now() - started),
    cancelled: controller.signal.aborted,
    truncated: false,
    request: { model: turn.model, messages, stream: true, stream_options: { include_usage: true } },
    response: {
      reply: turn.reply,
      reasoning: turn.reasoning,
      outputTokens: turn.outputTokens,
      reasoningTokens: turn.reasoningTokens,
      rate: turn.rate,
      error: failure instanceof Error ? failure.message : undefined,
    },
  });
}

function useChatConversation(node: string, model: string): ChatConversation {
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pending, setPending] = useState<ChatTurn | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<ActiveRequest | null>(null);
  useEffect(() => {
    return (): void => {
      const inFlight = active.current;
      active.current = null;
      if (inFlight) {
        inFlight.controller.abort();
        saveRequest(inFlight, null);
      }
    };
  }, []);

  function settle(controller: AbortController, turn: ChatTurn, failure: unknown): void {
    const request = active.current;
    if (request?.controller !== controller) return;
    active.current = null;
    saveRequest(request, failure);
    const stopped = controller.signal.aborted;
    if (turn.reply || turn.reasoning) setTurns((previous) => [...previous, { ...turn, stopped }]);
    if (!turn.reply) setDraft(turn.prompt);
    if (!stopped && (failure !== null || !turn.reply)) {
      setNotice(failure instanceof Error ? failure.message : "The model returned no text.");
    }
    setPending(null);
  }

  async function send(): Promise<void> {
    const prompt = draft.trim();
    if (prompt === "" || model === "" || active.current !== null) return;
    const messages = turns
      .filter(({ reply }) => reply !== "")
      .flatMap(({ prompt, reply }): ChatMessage[] => [
        { role: "user", content: prompt },
        { role: "assistant", content: reply },
      ]);
    const controller = new AbortController();
    const turn: ChatTurn = { prompt, model, reply: "", reasoning: "" };
    const request: ActiveRequest = {
      id: crypto.randomUUID(),
      node,
      at: Date.now(),
      started: performance.now(),
      firstByteMs: null,
      status: 0,
      controller,
      turn,
      messages: [...messages, { role: "user", content: prompt }],
    };
    active.current = request;
    setDraft("");
    setNotice(null);
    setPending({ ...turn });
    let failure: unknown = null;
    try {
      await streamChat(
        node,
        model,
        request.messages,
        controller.signal,
        (progress) => {
          request.firstByteMs ??= Math.round(performance.now() - request.started);
          Object.assign(turn, progress);
          if (active.current?.controller === controller) setPending({ ...turn });
        },
        (status) => {
          request.status = status;
        },
      );
    } catch (error) {
      failure = error;
    }
    settle(controller, turn, failure);
  }

  function stop(): void {
    const inFlight = active.current;
    if (!inFlight) return;
    inFlight.controller.abort();
    settle(inFlight.controller, inFlight.turn, null);
  }

  function reset(): void {
    setDraft("");
    setTurns([]);
    setNotice(null);
  }

  return {
    draft,
    setDraft,
    turns,
    pending,
    notice,
    send,
    stop,
    reset,
  };
}

export function ChatView({ node }: { node: string }): React.JSX.Element {
  const catalog = useQuery({
    queryKey: ["console-chat-models", node],
    queryFn: ({ signal }) => loadChatModels(node, signal),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const models = catalog.data ?? [];
  const [picked, setPicked] = useState("");
  const model = models.includes(picked) ? picked : (models[0] ?? "");
  const { draft, setDraft, turns, pending, notice, send, stop, reset } = useChatConversation(
    node,
    model,
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  return (
    <main className="console-page chat-page">
      <header className="chat-header">
        <h1>Chat</h1>
        <div className="chat-controls">
          <label>
            <span className="console-caption">Model</span>
            <select
              className="console-select"
              value={model}
              disabled={models.length === 0 || pending !== null}
              onChange={(event) => {
                setPicked(event.target.value);
              }}
            >
              {models.length === 0 ? (
                <option value="">{catalog.isPending ? "Loading models…" : "No models"}</option>
              ) : null}
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chat-button"
            disabled={pending !== null || (turns.length === 0 && !draft && !notice)}
            onClick={() => {
              reset();
              composer.current?.focus();
            }}
          >
            New chat
          </button>
        </div>
      </header>
      {catalog.isError || (catalog.isSuccess && models.length === 0) ? (
        <div className="chat-catalog-status" role="status">
          <span>
            {catalog.isError
              ? "Could not load models for this node."
              : "No models are available on this node."}
          </span>
          <button type="button" className="chat-button" onClick={() => void catalog.refetch()}>
            Refresh models
          </button>
        </div>
      ) : null}
      <ChatTranscript turns={turns} pending={pending} />
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {notice ? (
          <p className="chat-error" role="alert">
            {notice}
          </p>
        ) : null}
        <label className="console-caption" htmlFor="chat-message">
          Message
        </label>
        <textarea
          ref={composer}
          id="chat-message"
          rows={3}
          value={draft}
          readOnly={pending !== null}
          placeholder="Message the selected model"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="chat-form-actions">
          <span className="chat-key-hint">Shift + Enter for a new line</span>
          {pending ? (
            <button key="stop" type="button" className="chat-button" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              key="send"
              type="submit"
              className="chat-button chat-send"
              disabled={!model || !draft.trim()}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
