import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

void React;

type Props = {
  id: string;
  agentId?: string;
  sessionScope?: string;
  cmd?: string;
  args?: string[];
  continueArgs?: string[];
  initialUseContinue?: boolean;
  resumeSessionId?: string | null;
  onTerminalStarted?: () => void;
  onFreshRestart?: () => void;
  cwd?: string;
};

type SpawnPtyResult = {
  id: string;
  state: "attached" | "spawned" | "restarted" | "exited";
  exited: boolean;
};

type ClaudeTranscriptProbe = {
  sessionId: string | null;
  sessionPath: string | null;
};

const hasTauriBridge = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function TerminalPane({
  id,
  agentId,
  sessionScope,
  cmd = "claude",
  args = [],
  continueArgs,
  initialUseContinue = false,
  resumeSessionId,
  onTerminalStarted,
  onFreshRestart,
  cwd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onTerminalStartedRef = useRef(onTerminalStarted);
  const [exited, setExited] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const isPreview = !hasTauriBridge();

  useEffect(() => {
    onTerminalStartedRef.current = onTerminalStarted;
  }, [onTerminalStarted]);

  const canResumeCurrentSession = async () => {
    if (cmd !== "claude" || !cwd || !resumeSessionId) return true;
    try {
      const transcript = await invoke<ClaudeTranscriptProbe>("read_claude_transcript", {
        cwd,
        limit: 1,
        sessionId: resumeSessionId,
      });
      return Boolean(transcript.sessionPath);
    } catch {
      return true;
    }
  };

  const noteMissingResume = (term: Terminal) => {
    if (cmd !== "claude" || !resumeSessionId) return;
    term.write("\r\n\x1b[90m[resume session not found; starting a fresh Claude session]\x1b[0m\r\n");
  };

  const spawn = async (useContinue: boolean, restart = true) => {
    const term = termRef.current;
    if (!term) return;
    const shouldUseContinue = useContinue && continueArgs ? await canResumeCurrentSession() : false;
    if (useContinue && continueArgs && !shouldUseContinue) {
      noteMissingResume(term);
    }
    const finalArgs = shouldUseContinue && continueArgs ? continueArgs : args;
    try {
      const result = await invoke<SpawnPtyResult>("spawn_pty", {
        args: {
          id,
          agentId,
          sessionScope,
          cwd,
          cmd,
          args: finalArgs,
          restart,
          cols: term.cols,
          rows: term.rows,
        },
      });
      if (!result.exited) {
        onTerminalStartedRef.current?.();
      }
      setExited(result.exited);
    } catch (e) {
      term.write(`\r\n\x1b[31m[spawn failed: ${e}]\x1b[0m\r\n`);
    }
  };

  useEffect(() => {
    if (isPreview) return;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: "#0b0b0d",
        foreground: "#e6e6e6",
        cursor: "#ffa657",
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    let fitFrame: number | null = null;
    let resizeCommandTimer: number | null = null;
    let lastFitSize: { width: number; height: number } | null = null;
    let lastPtySize: { cols: number; rows: number } | null = null;
    let spawned = false;

    const fitToContainer = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;
      if (lastFitSize?.width === width && lastFitSize.height === height) return;
      lastFitSize = { width, height };

      try {
        fit.fit();
      } catch {}
    };

    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fitToContainer();
      });
    };

    const waitForStableFit = async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        fitToContainer();
      }
    };

    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let disposed = false;
    let receivedData = false;
    const replayBuffer = () => {
      invoke<number[]>("read_pty_buffer", { id })
        .then((buffer) => {
          if (!disposed && !receivedData && buffer.length > 0) {
            receivedData = true;
            term.write(new Uint8Array(buffer));
          }
        })
        .catch(() => {});
    };

    (async () => {
      try {
        setIsConnecting(true);
        await waitForStableFit();
        if (disposed) return;

        unlistenData = await listen<{ id: string; data: number[] }>(
          `pty:data:${id}`,
          (e) => {
            receivedData = true;
            term.write(new Uint8Array(e.payload.data));
          },
        );
        unlistenExit = await listen<{ id: string }>(`pty:exit:${id}`, () => {
          term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
          setExited(true);
        });

        if (disposed) return;

        const shouldUseContinue =
          initialUseContinue && continueArgs ? await canResumeCurrentSession() : false;
        if (initialUseContinue && continueArgs && !shouldUseContinue) {
          noteMissingResume(term);
        }
        const initialArgs = shouldUseContinue && continueArgs ? continueArgs : args;
        const result = await invoke<SpawnPtyResult>("spawn_pty", {
          args: { id, agentId, sessionScope, cwd, cmd, args: initialArgs, restart: false, cols: term.cols, rows: term.rows },
        });
        spawned = true;
        lastPtySize = { cols: term.cols, rows: term.rows };
        setIsConnecting(false);
        setExited(result.exited);
        replayBuffer();
        window.setTimeout(replayBuffer, 250);
        window.setTimeout(replayBuffer, 1000);
        if (!result.exited) {
          onTerminalStartedRef.current?.();
        }

        term.onData((data) => {
          invoke("write_pty", {
            id,
            data: Array.from(new TextEncoder().encode(data)),
          });
        });

        term.onResize(({ cols, rows }) => {
          if (!spawned) return;
          if (lastPtySize?.cols === cols && lastPtySize.rows === rows) return;
          lastPtySize = { cols, rows };
          if (resizeCommandTimer !== null) {
            window.clearTimeout(resizeCommandTimer);
          }
          resizeCommandTimer = window.setTimeout(() => {
            resizeCommandTimer = null;
            invoke("resize_pty", { id, cols, rows });
          }, 180);
        });
      } catch (error) {
        if (!disposed) {
          setIsConnecting(false);
          term.write(`\r\n\x1b[31m[terminal failed to connect: ${error}]\x1b[0m\r\n`);
        }
      }
    })();

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);

    return () => {
      disposed = true;
      setIsConnecting(false);
      if (fitFrame !== null) {
        window.cancelAnimationFrame(fitFrame);
      }
      if (resizeCommandTimer !== null) {
        window.clearTimeout(resizeCommandTimer);
      }
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      termRef.current = null;
    };
  }, [agentId, cmd, cwd, id, isPreview, sessionScope]);

  if (isPreview) {
    return (
      <div className="term-wrap preview-terminal" aria-label={`${id} terminal preview`}>
        <div className="preview-term-line">
          <span className="preview-prompt">{cwd ?? "~"}</span>
        </div>
        <div className="preview-term-line">{cmd} session ready</div>
        <div className="preview-term-line muted">preview bridge active: desktop PTY starts inside Tauri</div>
        <div className="preview-term-line">mailbox: dev profile inbox for {id}</div>
        <div className="preview-term-cursor" />
      </div>
    );
  }

  return (
    <div className="term-wrap">
      <div ref={containerRef} className="term-host" />
      {isConnecting && <div className="terminal-status">connecting...</div>}
      {exited && (
        <div className="exit-overlay">
          <div className="exit-msg">process exited</div>
          <div className="exit-actions">
            <button className="btn" onClick={() => spawn(true, true)}>
              Restart (continue session)
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                if (onFreshRestart) {
                  onFreshRestart();
                  return;
                }
                void spawn(false);
              }}
            >
              Restart fresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
