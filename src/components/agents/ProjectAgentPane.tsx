import React, { useEffect, useRef, useState } from "react";
import { systemPromptFor } from "../../agentPrompts";
import { scopedAgentId, shortPath } from "../../bridgeUtils";
import { runtimeAdapters } from "../../runtimeAdapters";
import type {
  AgentPaneStatus,
  AgentRecord,
  RuntimeContext,
  TranscriptMessageRecord,
} from "../../types";
import { TerminalPane } from "../TerminalPane";
import { AgentTranscriptChat } from "./AgentTranscriptChat";

void React;

export type AgentPaneSize = {
  width: number;
  height: number;
};

type ResizeAxis = "x" | "y" | "both";

type AppInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

type Props = {
  roomId: string;
  agent: AgentRecord;
  status: AgentPaneStatus;
  selected: boolean;
  focused: boolean;
  runtimeContext: RuntimeContext;
  allAgents: AgentRecord[];
  shouldResume: boolean;
  paneSize?: AgentPaneSize;
  dragging: boolean;
  dragOver: boolean;
  appInvoke: AppInvoke;
  onSelect: (id: string) => void;
  onOpenDetails: (id: string) => void;
  onFocus: (id: string) => void;
  onPaneResize: (size: AgentPaneSize | null) => void;
  onPaneDragStart: (id: string) => void;
  onPaneDragMove: (draggedId: string, targetId: string) => void;
  onPaneDragEnd: () => void;
  onPrepareClaudeSession: (id: string) => void;
  onTerminalStarted: (id: string) => void;
  onTranscriptSession: (id: string, sessionId: string) => void;
  onTranscriptMessages: (agentId: string, messages: TranscriptMessageRecord[]) => void;
  onSendMessage: (id: string, body: string) => Promise<void>;
  onFreshRestart: (id: string, ptyId: string) => void;
};

export function ProjectAgentPane({
  roomId,
  agent,
  status,
  selected,
  focused,
  runtimeContext,
  allAgents,
  shouldResume,
  paneSize,
  dragging,
  dragOver,
  appInvoke,
  onSelect,
  onOpenDetails,
  onFocus,
  onPaneResize,
  onPaneDragStart,
  onPaneDragMove,
  onPaneDragEnd,
  onPrepareClaudeSession,
  onTerminalStarted,
  onTranscriptSession,
  onTranscriptMessages,
  onSendMessage,
  onFreshRestart,
}: Props) {
  const paneRef = useRef<HTMLElement | null>(null);
  const [terminalReady, setTerminalReady] = useState(selected || focused);
  const [paneView, setPaneView] = useState<"chat" | "terminal">("chat");
  const [resizeAxis, setResizeAxis] = useState<ResizeAxis | null>(null);
  const [terminalResetKey, setTerminalResetKey] = useState(0);
  const adapter = runtimeAdapters[agent.runtime];
  const sessionScope = `${roomId}:${agent.id}`;
  const ptyId = scopedAgentId(roomId, agent.id);
  const accentColor = agent.accentColor ?? "#d6d876";
  const context = {
    ...runtimeContext,
    systemPrompt: () => systemPromptFor(agent, allAgents, runtimeContext.mailboxRoot),
  };

  useEffect(() => {
    if (terminalReady) return;
    if (selected || focused) {
      setTerminalReady(true);
      return;
    }

    const pane = paneRef.current;
    if (!pane || !("IntersectionObserver" in window)) {
      setTerminalReady(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setTerminalReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(pane);
    return () => observer.disconnect();
  }, [focused, selected, terminalReady]);

  useEffect(() => {
    if (terminalReady && agent.runtime === "claude" && !agent.sessionId) {
      onPrepareClaudeSession(agent.id);
    }
  }, [agent.id, agent.runtime, agent.sessionId, onPrepareClaudeSession, terminalReady]);

  const terminalCanLaunch = agent.runtime !== "claude" || Boolean(agent.sessionId);

  const restartFresh = async () => {
    await onFreshRestart(agent.id, ptyId);
    setTerminalResetKey((value) => value + 1);
  };

  const getResizeBounds = () => {
    const pane = paneRef.current;
    const parentWidth = pane?.parentElement?.getBoundingClientRect().width ?? pane?.getBoundingClientRect().width ?? 560;
    const minWidth = Math.min(parentWidth, 360);
    return {
      minWidth,
      maxWidth: Math.max(minWidth, parentWidth),
      minHeight: 280,
      maxHeight: Math.max(560, Math.round(window.innerHeight * 1.35)),
    };
  };

  const resizeByKeyboard = (widthDelta: number, heightDelta: number) => {
    const pane = paneRef.current;
    if (!pane) return;
    const bounds = getResizeBounds();
    const rect = pane.getBoundingClientRect();
    onPaneResize({
      width: clamp(Math.round((paneSize?.width ?? rect.width) + widthDelta), bounds.minWidth, bounds.maxWidth),
      height: clamp(Math.round((paneSize?.height ?? rect.height) + heightDelta), bounds.minHeight, bounds.maxHeight),
    });
  };

  const startPaneResize = (event: React.PointerEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    if (event.button !== 0) return;
    const pane = paneRef.current;
    if (!pane) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = pane.getBoundingClientRect();
    const bounds = getResizeBounds();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = paneSize?.width ?? rect.width;
    const startHeight = paneSize?.height ?? rect.height;
    let resizeFrame: number | null = null;
    let pendingSize: AgentPaneSize | null = null;

    const commitPendingSize = () => {
      resizeFrame = null;
      if (pendingSize) onPaneResize(pendingSize);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      pendingSize = {
        width: axis === "y"
          ? startWidth
          : clamp(Math.round(startWidth + moveEvent.clientX - startX), bounds.minWidth, bounds.maxWidth),
        height: axis === "x"
          ? startHeight
          : clamp(Math.round(startHeight + moveEvent.clientY - startY), bounds.minHeight, bounds.maxHeight),
      };
      if (resizeFrame === null) {
        resizeFrame = window.requestAnimationFrame(commitPendingSize);
      }
    };

    const finishResize = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        commitPendingSize();
      }
      setResizeAxis(null);
      document.body.classList.remove("is-pane-resizing");
      document.body.classList.remove("is-pane-resizing-x");
      document.body.classList.remove("is-pane-resizing-y");
      document.body.classList.remove("is-pane-resizing-both");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    setResizeAxis(axis);
    document.body.classList.add("is-pane-resizing");
    document.body.classList.add(`is-pane-resizing-${axis}`);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const onResizeHandleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    const step = event.shiftKey ? 96 : 32;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeByKeyboard(axis === "y" ? 0 : step, 0);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeByKeyboard(axis === "y" ? 0 : -step, 0);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeByKeyboard(0, axis === "x" ? 0 : step);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeByKeyboard(0, axis === "x" ? 0 : -step);
    } else if (event.key === "Escape" || event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      onPaneResize(null);
    }
  };

  const startPaneHeaderDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || focused) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(".agent-pane-actions, .pane-resize-edge, .pane-resize-corner")
    ) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let didDrag = false;
    let lastTargetId: string | null = null;

    const finishDrag = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      document.body.classList.remove("is-pane-dragging");
      if (didDrag) {
        onPaneDragEnd();
      }
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!didDrag && Math.hypot(deltaX, deltaY) < 8) return;
      if (!didDrag) {
        didDrag = true;
        onPaneDragStart(agent.id);
        document.body.classList.add("is-pane-dragging");
      }
      moveEvent.preventDefault();

      const targetPane = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-agent-pane-id]");
      const targetId = targetPane?.dataset.agentPaneId ?? null;
      if (targetId && targetId !== agent.id && targetId !== lastTargetId) {
        lastTargetId = targetId;
        onPaneDragMove(agent.id, targetId);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  };

  const paneStyle = {
    "--agent-accent": accentColor,
    "--pane-width": paneSize?.width ? `${paneSize.width}px` : undefined,
    "--pane-height": paneSize?.height ? `${paneSize.height}px` : undefined,
  } as React.CSSProperties;

  return (
    <article
      ref={paneRef}
      data-agent-pane-id={agent.id}
      className={`agent-pane ${selected ? "is-selected" : ""} ${focused ? "is-focused" : ""} ${resizeAxis ? `is-resizing is-resizing-${resizeAxis}` : ""} ${dragging ? "is-dragging" : ""} ${dragOver ? "is-drag-over" : ""}`}
      style={paneStyle}
    >
      <div
        className="agent-pane-header"
        onPointerDown={startPaneHeaderDrag}
        title={focused ? undefined : "Drag header to move this pane"}
      >
        <button className="agent-pane-title" onClick={() => onSelect(agent.id)} type="button">
          <span className="agent-color" style={{ background: accentColor }} />
          <span>
            <strong>{agent.label}</strong>
            <small>{agent.role}</small>
          </span>
        </button>
        <div className="agent-pane-actions">
          <code>{agent.runtime}</code>
          <span className={`status-pill is-${status}`}>{status}</span>
          <button className="btn" onClick={() => onOpenDetails(agent.id)} type="button">
            Details
          </button>
          <div className="pane-mode-toggle" aria-label={`${agent.label} view`}>
            <button
              className={paneView === "chat" ? "is-active" : ""}
              onClick={() => setPaneView("chat")}
              type="button"
            >
              Chat
            </button>
            <button
              className={paneView === "terminal" ? "is-active" : ""}
              onClick={() => setPaneView("terminal")}
              type="button"
            >
              Terminal
            </button>
          </div>
          <button className="btn" onClick={() => onFocus(agent.id)}>
            {focused ? "Exit focus" : "Focus"}
          </button>
        </div>
      </div>
      <div className="agent-project-path" title={agent.cwd ?? undefined}>{shortPath(agent.cwd)}</div>
      <div className="agent-live-slot">
        <div className={`pane-layer ${paneView === "terminal" ? "is-active" : ""}`} aria-hidden={paneView !== "terminal"}>
          {terminalReady && terminalCanLaunch ? (
            <TerminalPane
              key={`${ptyId}:${terminalResetKey}`}
              id={ptyId}
              agentId={agent.id}
              sessionScope={sessionScope}
              cmd={adapter.command}
              args={adapter.freshArgs(agent.id, context, agent.sessionId)}
              continueArgs={adapter.resumeArgs(agent.id, context, agent.sessionId)}
              initialUseContinue={shouldResume}
              resumeSessionId={agent.sessionId}
              onTerminalStarted={() => onTerminalStarted(agent.id)}
              onFreshRestart={restartFresh}
              cwd={agent.cwd ?? undefined}
            />
          ) : (
            <div className="terminal-standby" aria-label={`${agent.label} terminal standby`}>
              <span>{terminalReady ? "preparing session" : "standby"}</span>
            </div>
          )}
        </div>
        <div className={`pane-layer ${paneView === "chat" ? "is-active" : ""}`} aria-hidden={paneView !== "chat"}>
          <AgentTranscriptChat
            roomId={roomId}
            agent={agent}
            active={paneView === "chat"}
            canSend={status === "live"}
            appInvoke={appInvoke}
            onTranscriptSession={(sessionId) => onTranscriptSession(agent.id, sessionId)}
            onTranscriptMessages={(messages) => onTranscriptMessages(agent.id, messages)}
            onSendMessage={(body) => onSendMessage(agent.id, body)}
          />
        </div>
      </div>
      <button
        className="pane-resize-edge is-vertical"
        type="button"
        aria-label={`Resize ${agent.label} pane width`}
        title="Drag the border to resize width. Double-click to reset."
        onPointerDown={(event) => startPaneResize(event, "x")}
        onDoubleClick={() => onPaneResize(null)}
        onKeyDown={(event) => onResizeHandleKeyDown(event, "x")}
      />
      <button
        className="pane-resize-edge is-horizontal"
        type="button"
        aria-label={`Resize ${agent.label} pane height`}
        title="Drag the border to resize height. Double-click to reset."
        onPointerDown={(event) => startPaneResize(event, "y")}
        onDoubleClick={() => onPaneResize(null)}
        onKeyDown={(event) => onResizeHandleKeyDown(event, "y")}
      />
      <button
        className="pane-resize-corner"
        type="button"
        aria-label={`Resize ${agent.label} pane width and height`}
        title="Drag the corner to resize both. Double-click to reset."
        onPointerDown={(event) => startPaneResize(event, "both")}
        onDoubleClick={() => onPaneResize(null)}
        onKeyDown={(event) => onResizeHandleKeyDown(event, "both")}
      />
    </article>
  );
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
