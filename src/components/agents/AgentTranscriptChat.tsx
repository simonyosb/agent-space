import { Fragment, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { AgentRecord, TranscriptMessageRecord } from "../../types";

type AgentTranscriptChatAgent = Pick<AgentRecord, "id" | "label" | "runtime" | "cwd" | "sessionId">;

type ClaudeTranscript = {
  sessionId: string | null;
  sessionPath: string | null;
  updatedAt: string | null;
  messages: TranscriptMessageRecord[];
};

type ClaudeTranscriptEvent = {
  agentId: string;
  transcript: ClaudeTranscript;
};

type ClaudeTranscriptErrorEvent = {
  agentId: string;
  error: string;
};

type Props = {
  roomId: string;
  agent: AgentTranscriptChatAgent;
  active: boolean;
  canSend: boolean;
  appInvoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  onTranscriptSession: (sessionId: string) => void;
  onTranscriptMessages: (messages: TranscriptMessageRecord[]) => void;
  onSendMessage: (body: string) => Promise<void>;
};

const hasTauriBridge = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const toolEventName = (body: string) => {
  const match = body.trim().match(/^\[tool:\s*([^\]]+)\]$/);
  return match?.[1] ?? null;
};

function renderInlineMarkdown(text: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function ChatMessageBody({ body }: { body: string }) {
  const segments = body.split(/(```[\s\S]*?```)/g).filter(Boolean);

  return (
    <div className="chat-message-body">
      {segments.map((segment, segmentIndex) => {
        if (segment.startsWith("```") && segment.endsWith("```")) {
          const code = segment.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trimEnd();
          return <pre key={segmentIndex}><code>{code}</code></pre>;
        }

        return segment
          .split(/\n{2,}/)
          .map((block, blockIndex) => {
            const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
            if (lines.length === 0) return null;

            const everyLineIsBullet = lines.every((line) => /^[-*]\s+/.test(line.trim()));
            if (everyLineIsBullet) {
              return (
                <ul key={`${segmentIndex}-${blockIndex}`}>
                  {lines.map((line, lineIndex) => (
                    <li key={lineIndex}>{renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ""))}</li>
                  ))}
                </ul>
              );
            }

            return (
              <p key={`${segmentIndex}-${blockIndex}`}>
                {lines.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInlineMarkdown(line.trim())}
                  </Fragment>
                ))}
              </p>
            );
          });
      })}
    </div>
  );
}

export function AgentTranscriptChat({
  roomId,
  agent,
  active,
  canSend,
  appInvoke,
  onTranscriptSession,
  onTranscriptMessages,
  onSendMessage,
}: Props) {
  const [transcript, setTranscript] = useState<ClaudeTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const onTranscriptSessionRef = useRef(onTranscriptSession);
  const onTranscriptMessagesRef = useRef(onTranscriptMessages);
  const isClaude = agent.runtime === "claude";
  const transcriptKey = `${roomId}:${agent.id}`;

  useEffect(() => {
    onTranscriptSessionRef.current = onTranscriptSession;
  }, [onTranscriptSession]);

  useEffect(() => {
    onTranscriptMessagesRef.current = onTranscriptMessages;
  }, [onTranscriptMessages]);

  useEffect(() => {
    if (!active || !agent.cwd || !isClaude || !agent.sessionId) return;
    let cancelled = false;
    let unlistenTranscript: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;

    appInvoke<ClaudeTranscript>("read_claude_transcript", {
      agentId: transcriptKey,
      cwd: agent.cwd,
      limit: 80,
      sessionId: agent.sessionId,
    })
      .then((nextTranscript) => {
        if (cancelled) return;
        setTranscript(nextTranscript);
        if (nextTranscript.sessionId) onTranscriptSessionRef.current(nextTranscript.sessionId);
        setError(null);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(String(loadError));
      });

    if (hasTauriBridge()) {
      listen<ClaudeTranscriptEvent>(`claude:transcript:${transcriptKey}`, (event) => {
        if (cancelled) return;
        setTranscript(event.payload.transcript);
        if (event.payload.transcript.sessionId) {
          onTranscriptSessionRef.current(event.payload.transcript.sessionId);
        }
        setError(null);
      }).then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenTranscript = unlisten;
      });

      listen<ClaudeTranscriptErrorEvent>(`claude:transcript-error:${transcriptKey}`, (event) => {
        if (cancelled) return;
        setError(event.payload.error);
      }).then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenError = unlisten;
      });

      appInvoke("watch_claude_transcript", {
        agentId: transcriptKey,
        cwd: agent.cwd,
        limit: 80,
        sessionId: agent.sessionId,
      }).catch((watchError) => {
        if (!cancelled) setError(String(watchError));
      });
    }

    return () => {
      cancelled = true;
      unlistenTranscript?.();
      unlistenError?.();
      if (hasTauriBridge()) {
        appInvoke("stop_claude_transcript_watch", { agentId: transcriptKey }).catch(() => {});
      }
    };
  }, [active, agent.cwd, agent.sessionId, appInvoke, isClaude, transcriptKey]);

  useEffect(() => {
    if (!active) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [active, transcript?.messages.length]);

  useEffect(() => {
    if (!active || !transcript?.messages.length) return;
    onTranscriptMessagesRef.current(transcript.messages);
  }, [active, transcript]);

  const sendDraft = async () => {
    const body = draft.trim();
    if (!body || !canSend || isSending) return;
    setSendError(null);
    setIsSending(true);
    try {
      await onSendMessage(body);
      setDraft("");
    } catch (sendFailure) {
      setSendError(String(sendFailure));
    } finally {
      setIsSending(false);
    }
  };

  if (!agent.cwd) {
    return (
      <div className="chat-empty-state">
        <strong>No project path</strong>
        <span>Add a project path to read this agent's Claude session as chat.</span>
      </div>
    );
  }

  if (!isClaude) {
    return (
      <div className="chat-empty-state">
        <strong>Chat transcript unavailable</strong>
        <span>Codex panes still run in terminal mode. Claude JSONL chat is available for Claude agents.</span>
      </div>
    );
  }

  const messages = transcript?.messages ?? [];

  return (
    <section className="agent-chat" aria-label={`${agent.label} Claude transcript`}>
      <header className="agent-chat-header">
        <div>
          <strong>Chat</strong>
          <span title={transcript?.sessionPath ?? undefined}>
            {transcript?.sessionId ? `session ${transcript.sessionId.slice(0, 8)}` : "waiting for Claude session"}
          </span>
        </div>
        <code>{messages.length}</code>
      </header>

      <div ref={scrollerRef} className="chat-scroll">
        {messages.map((message) => {
          const toolName = toolEventName(message.body);
          if (toolName) {
            return (
              <div className="chat-event" key={message.id}>
                <span>tool</span>
                <code>{toolName}</code>
                {message.createdAt ? <time>{formatTime(message.createdAt)}</time> : null}
              </div>
            );
          }

          return (
            <article className={`chat-message is-${message.role}`} key={message.id}>
              <div className="chat-message-meta">
                <span>{message.role === "assistant" ? agent.label : "you"}</span>
                {message.createdAt ? <time>{formatTime(message.createdAt)}</time> : null}
              </div>
              <ChatMessageBody body={message.body} />
            </article>
          );
        })}
        {messages.length === 0 && !error ? (
          <div className="chat-empty-state">
            <strong>No transcript yet</strong>
            <span>Claude will appear here after this project has an active session in ~/.claude/projects.</span>
          </div>
        ) : null}
        {error ? (
          <div className="chat-empty-state is-error">
            <strong>Could not read transcript</strong>
            <span>{error}</span>
          </div>
        ) : null}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendDraft();
        }}
      >
        <textarea
          value={draft}
          placeholder={canSend ? `Ask ${agent.label}` : "Terminal is starting..."}
          disabled={!canSend || isSending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void sendDraft();
            }
          }}
        />
        <div className="chat-composer-actions">
          {sendError ? <span className="composer-error">{sendError}</span> : <span>{canSend ? "Cmd+Enter" : "Waiting for live PTY"}</span>}
          <button className="btn primary" disabled={!draft.trim() || !canSend || isSending} type="submit">
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}
