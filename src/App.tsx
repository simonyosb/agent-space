import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { systemPromptFor } from "./agentPrompts";
import { formatTime, scopedAgentId, shortPath } from "./bridgeUtils";
import { ProjectAgentPane, type AgentPaneSize } from "./components/agents/ProjectAgentPane";
import { QuickOpen, QuickOpenEntry } from "./components/shell/QuickOpen";
import type {
  AgentPaneStatus,
  AgentRecord,
  AgentRuntime,
  AutomationRecord,
  AutomationRunRecord,
  FleetState,
  LegacyTaskRecord,
  MessageRecord,
  ProjectWorkspace,
  PtyStatus,
  RoomRecord,
  RuntimeContext,
  TaskStatus,
  TranscriptMessageRecord,
} from "./types";
import "./App.css";

void React;

const agentColors = [
  "#e5e5e5",
  "#86efac",
  "#93c5fd",
  "#c4b5fd",
  "#fbbf24",
  "#fca5a5",
  "#67e8f9",
  "#d6d3d1",
];

const encode = (data: string) => Array.from(new TextEncoder().encode(data));
const defaultAgentColor = (index: number) => agentColors[index % agentColors.length];
const hasTauriBridge = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskStatuses: TaskStatus[] = ["backlog", "active", "blocked", "review", "done"];
const paneSizeStorageKey = "agentspace:pane-sizes";
const previewStateStorageKey = "agentspace:preview-fleet-state";
const createSessionId = () =>
  globalThis.crypto?.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) =>
    (Number(char) ^ (Math.random() * 16) >> (Number(char) / 4)).toString(16),
  );

const nextId = (prefix: string, existingIds: string[]) => {
  let n = existingIds.length + 1;
  let id = `${prefix}-${n}`;
  while (existingIds.includes(id)) {
    n += 1;
    id = `${prefix}-${n}`;
  }
  return id;
};

const projectNameFromPath = (path: string) =>
  path.trim().split("/").filter(Boolean).pop() || "project";

const sameFleetState = (a: FleetState | null, b: FleetState) => {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

const loadPaneSizes = (): Record<string, AgentPaneSize> => {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(paneSizeStorageKey);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Record<string, Partial<AgentPaneSize>>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, size]) => Number.isFinite(size.width) && Number.isFinite(size.height))
        .map(([key, size]) => [
          key,
          {
            width: Math.max(280, Math.round(size.width ?? 0)),
            height: Math.max(240, Math.round(size.height ?? 0)),
          },
        ]),
    );
  } catch {
    return {};
  }
};

const isTaskStatus = (status: string): status is TaskStatus =>
  taskStatuses.includes(status as TaskStatus);

const normalizeStatus = (status: string | undefined): TaskStatus => {
  if (!status) return "backlog";
  if (status === "todo") return "backlog";
  if (status === "in-progress") return "active";
  if (status === "in-review") return "review";
  if (status === "complete" || status === "completed") return "done";
  return isTaskStatus(status) ? status : "backlog";
};

const uniqueValues = <T,>(values: T[]) => Array.from(new Set(values));

const taskReplyIds = (body: string, knownTaskIds: Set<string>) => {
  const found = new Set<string>();
  const tagPattern = /\[task:\s*([a-z0-9_-]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(body)) !== null) {
    if (knownTaskIds.has(match[1])) found.add(match[1]);
  }
  return [...found];
};

const snippetTitle = (body: string) => {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) return "Follow up on message";
  return collapsed.length > 64 ? `${collapsed.slice(0, 61)}...` : collapsed;
};

const previewFleetState = (): FleetState => ({
  schemaVersion: 5,
  activeRoomId: "preview-room",
  rooms: [],
  roomOrder: [],
  activeWorkspace: {
    id: "preview-room",
    name: "microservices",
    path: "/Users/zeemon/Development/microservices",
    createdAt: new Date().toISOString(),
  },
  mainAgentId: "agent-1",
  agents: [
    createAgent({
      id: "agent-1",
      label: "billing-service",
      runtime: "claude",
      role: "billing contracts",
      cwd: "/Users/zeemon/Development/billing-service",
      index: 0,
    }),
    createAgent({
      id: "agent-2",
      label: "auth-api",
      runtime: "claude",
      role: "identity owner",
      cwd: "/Users/zeemon/Development/auth-api",
      index: 1,
    }),
    createAgent({
      id: "agent-3",
      label: "web-app",
      runtime: "codex",
      role: "frontend shell",
      cwd: "/Users/zeemon/Development/web-app",
      index: 2,
    }),
  ],
  tasks: [],
  orchestratorChat: [],
  messages: [
    {
      id: "msg-preview-2",
      from: "agent-2",
      to: "agent-1",
      body: "Auth guarantees token subject stability across refresh; billing should key customer joins on account_id, not email.",
      createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    },
    {
      id: "msg-preview-1",
      from: "human",
      to: "agent-2",
      body: "What identifier is safe to use across billing and auth?",
      createdAt: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
    },
  ],
  runs: [],
  automations: [],
  automationRuns: [],
  workspaces: [],
});

const previewStore = () => {
  const previewWindow = window as Window & { __AGENT_SPACE_PREVIEW_STATE__?: FleetState };
  if (!previewWindow.__AGENT_SPACE_PREVIEW_STATE__) {
    try {
      const stored = window.localStorage.getItem(previewStateStorageKey);
      previewWindow.__AGENT_SPACE_PREVIEW_STATE__ = stored
        ? normalizeLoadedState(JSON.parse(stored) as FleetState)
        : previewFleetState();
    } catch {
      previewWindow.__AGENT_SPACE_PREVIEW_STATE__ = previewFleetState();
    }
  }
  return previewWindow;
};

async function appInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (hasTauriBridge()) {
    return invoke<T>(cmd, args);
  }

  const previewWindow = previewStore();
  switch (cmd) {
    case "get_mcp_config_path":
      return "~/.agent-space-dev/mcp.json" as T;
    case "get_fleet_mcp_binary_path":
      return "/Users/zeemon/Development/agent-space/src-tauri/target/debug/fleet-mcp" as T;
    case "get_fleet_socket_path":
      return "/tmp/agent-space-dev.sock" as T;
    case "get_mailbox_root":
      return "~/.agent-space-dev/mail" as T;
    case "load_fleet_state":
      return previewWindow.__AGENT_SPACE_PREVIEW_STATE__ as T;
    case "save_fleet_state":
      previewWindow.__AGENT_SPACE_PREVIEW_STATE__ = args?.state as FleetState;
      window.localStorage.setItem(previewStateStorageKey, JSON.stringify(args?.state));
      return undefined as T;
    case "open_project_workspace":
    case "create_project_workspace": {
      const path = String(args?.path ?? "/Users/zeemon/Development/microservices");
      return {
        id: "preview-room",
        name: String(args?.name ?? projectNameFromPath(path)),
        path,
        createdAt: new Date().toISOString(),
      } as T;
    }
    case "record_manual_message":
      return {
        id: `msg-preview-${Date.now()}`,
        from: String(args?.from ?? "human"),
        to: String(args?.to ?? "agent-1"),
        body: String(args?.body ?? ""),
        createdAt: new Date().toISOString(),
      } as T;
    case "read_claude_transcript":
      return {
        sessionId: "preview-session",
        sessionPath: "~/.claude/projects/preview/preview-session.jsonl",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "preview-user",
            role: "user",
            body: "Does auth guarantee ordering for account events?",
            createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
          },
          {
            id: "preview-assistant",
            role: "assistant",
            body: "Auth preserves order per account_id inside one partition. Cross-account events can arrive independently, so consumers should not infer global ordering.",
            createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
          },
        ],
      } as T;
    case "get_pty_status":
      return {
        id: String(args?.id ?? ""),
        exists: false,
        exited: false,
        bufferLen: 0,
      } as T;
    case "list_pty_statuses":
      return [] as T;
    case "write_pty":
    case "watch_claude_transcript":
    case "stop_claude_transcript_watch":
    case "plugin:dialog|open":
      return null as T;
    default:
      return undefined as T;
  }
}

async function checkForProductionUpdate() {
  if (!hasTauriBridge() || import.meta.env.DEV) return;

  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
    const update = await check();
    if (!update) return;

    const shouldInstall = window.confirm(
      `AgentSpace ${update.version} is available. Install it and restart now?`,
    );
    if (!shouldInstall) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    console.error("Failed to check for AgentSpace updates:", error);
  }
}

const hasUsableSession = (agent: AgentRecord) => {
  if (agent.runtime === "codex") return agent.status === "session-started";
  return Boolean(agent.sessionId && agent.status === "session-started");
};

const agentPaneStatus = (
  agent: AgentRecord,
  ptyId: string,
  ptyStatuses: Record<string, PtyStatus>,
): AgentPaneStatus => {
  const ptyStatus = ptyStatuses[ptyId];
  if (ptyStatus?.exists && ptyStatus.exited) return "exited";
  if (ptyStatus?.exists) return "live";
  if (hasUsableSession(agent)) return "resume";
  return "ready";
};

function createAgent({
  id,
  label,
  runtime,
  role,
  cwd,
  index,
}: {
  id: string;
  label: string;
  runtime: AgentRuntime;
  role: string;
  cwd: string;
  index: number;
}): AgentRecord {
  return {
    id,
    label,
    accentColor: defaultAgentColor(index),
    title: null,
    runtime,
    role,
    reportsTo: null,
    capabilities: `Local expert for ${cwd}. Answer questions from this project; ask peers when another project owns the truth.`,
    cwd,
    worktree: null,
    instructions: "",
    instructionsBundle: null,
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    permissions: { canCreateAgents: false, canManageTasks: false },
    sourceTaskId: null,
    sessionId: runtime === "claude" ? null : createSessionId(),
    status: "idle",
  };
}

function App() {
  const [fleetState, setFleetState] = useState<FleetState | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mcpConfigPath, setMcpConfigPath] = useState<string | null>(null);
  const [mcpBinaryPath, setMcpBinaryPath] = useState<string | null>(null);
  const [fleetSocketPath, setFleetSocketPath] = useState<string | null>(null);
  const [setupPath, setSetupPath] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [newAgentPath, setNewAgentPath] = useState("");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("service owner");
  const [newAgentRuntime, setNewAgentRuntime] = useState<AgentRuntime>("claude");
  const [isAddAgentOpen, setIsAddAgentOpen] = useState(false);
  const [isEditAgentOpen, setIsEditAgentOpen] = useState(false);
  const [isAgentDetailsOpen, setIsAgentDetailsOpen] = useState(false);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [manualMessage, setManualMessage] = useState("");
  const [manualRecipient, setManualRecipient] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [mailboxRoot, setMailboxRoot] = useState<string | null>(null);
  const [ptyStatuses, setPtyStatuses] = useState<Record<string, PtyStatus>>({});
  const [agentPaneSizes, setAgentPaneSizes] = useState<Record<string, AgentPaneSize>>(loadPaneSizes);
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [dragOverWorkspaceId, setDragOverWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    void checkForProductionUpdate();
  }, []);

  useEffect(() => {
    Promise.all([
      appInvoke<string>("get_mcp_config_path"),
      appInvoke<string>("get_fleet_mcp_binary_path"),
      appInvoke<string>("get_fleet_socket_path"),
      appInvoke<string>("get_mailbox_root"),
      appInvoke<FleetState>("load_fleet_state"),
    ])
      .then(([configPath, binaryPath, socketPath, mailboxPath, loadedState]) => {
        const state = normalizeLoadedState(loadedState);
        setMcpConfigPath(configPath);
        setMcpBinaryPath(binaryPath);
        setFleetSocketPath(socketPath);
        setMailboxRoot(mailboxPath);
        setFleetState(state);
        const initialAgentId =
          state.rooms.find((room) => room.id === state.activeRoomId)?.selectedAgentId ??
          state.agents[0]?.id ??
          null;
        setSelectedAgentId(initialAgentId);
        setManualRecipient(initialAgentId ?? "");
        setNewAgentPath(state.activeWorkspace?.path ?? "");
      })
      .catch((error) => console.error("Failed to load fleet state:", error));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      appInvoke<FleetState>("load_fleet_state")
        .then((state) => {
          const normalized = normalizeLoadedState(state);
          setFleetState((current) => (sameFleetState(current, normalized) ? current : normalized));
        })
        .catch((error) => console.error("Failed to refresh fleet state:", error));
    }, 2500);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshPtyStatuses = () => {
      appInvoke<PtyStatus[]>("list_pty_statuses")
        .then((statuses) => {
          if (cancelled) return;
          setPtyStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
        })
        .catch((error) => console.error("Failed to refresh PTY statuses:", error));
    };
    refreshPtyStatuses();
    const interval = window.setInterval(refreshPtyStatuses, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(paneSizeStorageKey, JSON.stringify(agentPaneSizes));
    } catch (error) {
      console.error("Failed to save pane sizes:", error);
    }
  }, [agentPaneSizes]);

  useEffect(() => {
    if (!isAddAgentOpen && !isEditAgentOpen && !isFocusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAddAgentOpen(false);
        setIsEditAgentOpen(false);
        setIsFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAddAgentOpen, isEditAgentOpen, isFocusMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isQuickOpenShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isQuickOpenShortcut) return;
      event.preventDefault();
      setIsQuickOpenOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const runtimeContext = useMemo<RuntimeContext | null>(() => {
    if (!mcpBinaryPath || !mcpConfigPath || !fleetSocketPath || !fleetState) return null;
    return {
      mcpBinaryPath,
      mcpConfigPath,
      fleetSocketPath,
      mailboxRoot,
      systemPrompt: (agentId) => {
        const agent = fleetState.agents.find((item) => item.id === agentId);
        return agent ? systemPromptFor(agent, fleetState.agents, mailboxRoot) : agentId;
      },
    };
  }, [fleetState, fleetSocketPath, mailboxRoot, mcpBinaryPath, mcpConfigPath]);

  const saveState = (nextState: FleetState, selectedAgentOverride = selectedAgentId) => {
    const normalized = persistActiveRoom(normalizeLoadedState(nextState), selectedAgentOverride);
    setFleetState(normalized);
    appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
      console.error("Failed to save fleet state:", error),
    );
  };

  const appendMessagesToState = (messages: MessageRecord[]) => {
    if (messages.length === 0) return;
    setFleetState((current) => {
      if (!current) return current;
      const existingIds = new Set(current.messages.map((message) => message.id));
      const newMessages = messages.filter((message) => !existingIds.has(message.id));
      if (newMessages.length === 0) return current;
      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        messages: [...newMessages, ...current.messages],
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to append messages:", error),
      );
      return normalized;
    });
  };

  const activateWorkspace = (workspace: ProjectWorkspace) => {
    if (fleetState) {
      const currentState = persistActiveRoom(normalizeLoadedState(fleetState), selectedAgentId);
      const existingRoom = currentState.rooms.find(
        (room) => room.workspace.id === workspace.id || room.workspace.path === workspace.path,
      );
      if (existingRoom) {
        const nextState = applyRoomToState(currentState, {
          ...existingRoom,
          workspace: { ...existingRoom.workspace, name: workspace.name || existingRoom.workspace.name },
        });
        const nextSelectedAgentId = existingRoom.selectedAgentId ?? nextState.mainAgentId ?? nextState.agents[0]?.id ?? null;
        saveState(nextState, nextSelectedAgentId);
        setSelectedAgentId(nextSelectedAgentId);
        setManualRecipient(nextSelectedAgentId ?? "");
        setNewAgentPath(nextState.activeWorkspace?.path ?? "");
        return;
      }
    }

    const firstAgent = createAgent({
      id: "agent-1",
      label: workspace.name,
      runtime: "claude",
      role: "project expert",
      cwd: workspace.path,
      index: 0,
    });
    const savedState = fleetState ? persistActiveRoom(normalizeLoadedState(fleetState), selectedAgentId) : null;
    const nextState: FleetState = {
      schemaVersion: 5,
      activeRoomId: workspace.id,
      rooms: savedState?.rooms ?? [],
      roomOrder: savedState?.roomOrder ?? [],
      activeWorkspace: workspace,
      mainAgentId: firstAgent.id,
      agents: [firstAgent],
      tasks: [],
      orchestratorChat: [],
      messages: [],
      runs: [],
      automations: [],
      automationRuns: [],
      workspaces: [],
    };
    saveState(nextState, firstAgent.id);
    setSelectedAgentId(firstAgent.id);
    setManualRecipient(firstAgent.id);
    setNewAgentPath(workspace.path);
  };

  const switchRoom = (roomId: string) => {
    if (!fleetState) return;
    const currentState = persistActiveRoom(normalizeLoadedState(fleetState), selectedAgentId);
    const room = currentState.rooms.find((item) => item.id === roomId);
    if (!room) return;
    const nextState = applyRoomToState(currentState, room);
    const nextSelectedAgentId = room.selectedAgentId ?? nextState.mainAgentId ?? nextState.agents[0]?.id ?? null;
    saveState(nextState, nextSelectedAgentId);
    setSelectedAgentId(nextSelectedAgentId);
    setManualRecipient(nextSelectedAgentId ?? "");
    setNewAgentPath(nextState.activeWorkspace?.path ?? "");
    setIsFocusMode(false);
    setIsEditAgentOpen(false);
  };

  const openAddAgentForRoom = (roomId: string) => {
    if (!fleetState) return;
    const room = fleetState.rooms.find((item) => item.id === roomId);
    if (!room) return;
    if (room.id !== fleetState.activeRoomId) switchRoom(room.id);
    setNewAgentPath(room.workspace.path);
    setIsFocusMode(false);
    setIsAddAgentOpen(true);
  };

  const removeWorkspace = (roomId: string) => {
    if (!fleetState) return;
    const currentState = persistActiveRoom(normalizeLoadedState(fleetState), selectedAgentId);
    const room = currentState.rooms.find((item) => item.id === roomId);
    if (!room) return;
    const confirmed = window.confirm(
      `Remove "${room.workspace.name}" from AgentSpace? This only removes the saved workspace, agents, and messages. Project files stay untouched.`,
    );
    if (!confirmed) return;

    const remainingRooms = currentState.rooms.filter((item) => item.id !== roomId);
    const remainingRoomOrder = currentState.roomOrder.filter((id) => id !== roomId);
    if (currentState.activeRoomId !== roomId) {
      saveState({ ...currentState, rooms: remainingRooms, roomOrder: remainingRoomOrder });
      return;
    }

    const nextRoom = remainingRooms[0] ?? null;
    if (nextRoom) {
      const nextState = applyRoomToState({
        ...currentState,
        rooms: remainingRooms,
        roomOrder: remainingRoomOrder,
      }, nextRoom);
      const nextSelectedAgentId = nextRoom.selectedAgentId ?? nextState.mainAgentId ?? nextState.agents[0]?.id ?? null;
      saveState(nextState, nextSelectedAgentId);
      setSelectedAgentId(nextSelectedAgentId);
      setManualRecipient(nextSelectedAgentId ?? "");
      setNewAgentPath(nextState.activeWorkspace?.path ?? "");
      setIsFocusMode(false);
      setIsEditAgentOpen(false);
      setIsAddAgentOpen(false);
      return;
    }

    const nextState = normalizeLoadedState({
      ...currentState,
      activeRoomId: null,
      rooms: [],
      roomOrder: [],
      activeWorkspace: null,
      mainAgentId: null,
      agents: [],
      tasks: [],
      orchestratorChat: [],
      messages: [],
      runs: [],
      automations: [],
      automationRuns: [],
      workspaces: [],
    });
    saveState(nextState, null);
    setSelectedAgentId(null);
    setManualRecipient("");
    setNewAgentPath("");
    setSetupPath("");
    setSetupName("");
    setIsFocusMode(false);
    setIsEditAgentOpen(false);
    setIsAddAgentOpen(false);
  };

  const startNewRoom = () => {
    if (!fleetState) return;
    const currentState = persistActiveRoom(normalizeLoadedState(fleetState), selectedAgentId);
    saveState(currentState);
    setSetupPath("");
    setSetupName("");
    setSetupError(null);
    setIsFocusMode(false);
    setIsWorkspaceModalOpen(true);
  };

  const openWorkspace = async () => {
    setSetupError(null);
    if (!setupPath.trim()) {
      setSetupError("Choose a home project path first.");
      return;
    }
    try {
      const workspace = await appInvoke<ProjectWorkspace>("open_project_workspace", { path: setupPath });
      activateWorkspace({
        ...workspace,
        name: setupName.trim() || workspace.name,
      });
      setIsWorkspaceModalOpen(false);
    } catch (error) {
      setSetupError(String(error));
    }
  };

  const createWorkspace = async () => {
    setSetupError(null);
    if (!setupPath.trim()) {
      setSetupError("Choose a home project path first.");
      return;
    }
    try {
      const workspace = await appInvoke<ProjectWorkspace>("create_project_workspace", {
        path: setupPath,
        name: setupName || null,
      });
      activateWorkspace(workspace);
      setIsWorkspaceModalOpen(false);
    } catch (error) {
      setSetupError(String(error));
    }
  };

  const browseSetupPath = async () => {
    try {
      const selected = await appInvoke<string | string[] | null>("plugin:dialog|open", {
        options: { directory: true, multiple: false, title: "Choose workspace project" },
      });
      if (typeof selected === "string") setSetupPath(selected);
    } catch (error) {
      setSetupError(String(error));
    }
  };

  const browseAgentPath = async () => {
    try {
      const selected = await appInvoke<string | string[] | null>("plugin:dialog|open", {
        options: { directory: true, multiple: false, title: "Choose agent project" },
      });
      if (typeof selected === "string") {
        setNewAgentPath(selected);
        if (!newAgentName.trim()) setNewAgentName(projectNameFromPath(selected));
      }
    } catch (error) {
      console.error("Failed to choose agent path:", error);
    }
  };

  const resetRoom = () => {
    if (!fleetState) return;
    startNewRoom();
  };

  const addAgent = () => {
    if (!fleetState?.activeWorkspace) return;
    const cwd = newAgentPath.trim();
    if (!cwd) return;
    const id = nextId("agent", fleetState.agents.map((agent) => agent.id));
    const agent = createAgent({
      id,
      label: newAgentName.trim() || projectNameFromPath(cwd),
      runtime: newAgentRuntime,
      role: newAgentRole.trim() || "project expert",
      cwd,
      index: fleetState.agents.length,
    });
    saveState({ ...fleetState, agents: [...fleetState.agents, agent] });
    setSelectedAgentId(id);
    setManualRecipient(id);
    setNewAgentName("");
    setIsAddAgentOpen(false);
  };

  const updateAgent = (id: string, patch: Partial<AgentRecord>) => {
    if (!fleetState) return;
    saveState({
      ...fleetState,
      agents: fleetState.agents.map((agent) =>
        agent.id === id ? { ...agent, ...patch } : agent,
      ),
    });
  };

  const removeAgent = (id: string) => {
    if (!fleetState) return;
    const agents = fleetState.agents.filter((agent) => agent.id !== id);
    saveState({
      ...fleetState,
      agents,
      mainAgentId: fleetState.mainAgentId === id ? agents[0]?.id ?? null : fleetState.mainAgentId,
    });
    setSelectedAgentId(agents[0]?.id ?? null);
    setManualRecipient(agents[0]?.id ?? "");
  };

  const prepareClaudeSession = (id: string) => {
    setFleetState((current) => {
      if (!current) return current;
      const existing = current.agents.find((agent) => agent.id === id);
      if (!existing || existing.runtime !== "claude" || existing.sessionId) return current;
      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        agents: current.agents.map((agent) =>
          agent.id === id
            ? { ...agent, sessionId: createSessionId(), status: "idle" }
            : agent,
        ),
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save prepared Claude session:", error),
      );
      return normalized;
    });
  };

  const markAgentTerminalStarted = (id: string) => {
    setFleetState((current) => {
      if (!current) return current;
      const existing = current.agents.find((agent) => agent.id === id);
      if (!existing || existing.status === "session-started" || existing.status === "terminal-started") {
        return current;
      }
      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        agents: current.agents.map((agent) =>
          agent.id === id
            ? {
                ...agent,
                sessionId: agent.runtime === "claude" ? agent.sessionId ?? createSessionId() : agent.sessionId,
                status: agent.runtime === "codex" ? "session-started" : "terminal-started",
              }
            : agent,
        ),
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save agent terminal marker:", error),
      );
      return normalized;
    });
  };

  const markAgentTranscriptSession = (id: string, sessionId: string) => {
    if (!sessionIdPattern.test(sessionId)) return;
    setFleetState((current) => {
      if (!current) return current;
      const existing = current.agents.find((agent) => agent.id === id);
      if (!existing) return current;
      if (existing.sessionId === sessionId && existing.status === "session-started") return current;
      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        agents: current.agents.map((agent) =>
          agent.id === id
            ? { ...agent, sessionId, status: "session-started" }
            : agent,
        ),
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save Claude transcript session:", error),
      );
      return normalized;
    });
  };

  const restartAgentFresh = async (id: string, ptyId: string) => {
    try {
      await appInvoke("kill_pty", { id: ptyId });
    } catch (error) {
      console.error("Failed to stop agent before fresh restart:", error);
    }
    setFleetState((current) => {
      if (!current) return current;
      const existing = current.agents.find((agent) => agent.id === id);
      if (!existing) return current;
      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        agents: current.agents.map((agent) =>
          agent.id === id
            ? { ...agent, sessionId: createSessionId(), status: "idle" }
            : agent,
        ),
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save fresh session marker:", error),
      );
      return normalized;
    });
  };

  const writePromptToAgent = async (agentId: string, message: string) => {
    if (!fleetState) throw new Error("No active fleet state.");
    const body = `[from human]: ${message}`;
    const targetPtyId = scopedAgentId(fleetState.activeRoomId ?? fleetState.activeWorkspace?.id, agentId);
    await appInvoke("write_pty", { id: targetPtyId, data: encode(body) });
    window.setTimeout(() => {
      appInvoke("write_pty", { id: targetPtyId, data: encode("\r") }).catch((error) =>
        console.error("Failed to submit message:", error),
      );
    }, 250);
    return appInvoke<MessageRecord>("record_manual_message", {
      from: "human",
      to: agentId,
      body: message,
    });
  };

  const sendManualMessage = async () => {
    const trimmedMessage = manualMessage.trim();
    if (!manualRecipient || !trimmedMessage || isSendingMessage) return;
    setManualError(null);
    setIsSendingMessage(true);
    try {
      if (fleetState) {
        const message = await writePromptToAgent(manualRecipient, trimmedMessage);
        appendMessagesToState([message]);
      }
      setManualMessage("");
    } catch (error) {
      setManualError(String(error));
    } finally {
      setIsSendingMessage(false);
    }
  };

  const sendAgentMessage = async (agentId: string, body: string) => {
    if (!fleetState) throw new Error("No active fleet state.");
    const message = await writePromptToAgent(agentId, body);
    appendMessagesToState([message]);
  };

  const recordTranscriptTaskMessages = useCallback((
    agentId: string,
    transcriptMessages: TranscriptMessageRecord[],
  ) => {
    setFleetState((current) => {
      if (!current) return current;
      const knownTaskIds = new Set(current.tasks.map((task) => task.id));
      const existingMessageIds = new Set(current.messages.map((message) => message.id));
      const agent = current.agents.find((item) => item.id === agentId);
      const records: Array<{ message: MessageRecord; taskIds: string[] }> = [];

      for (const transcriptMessage of transcriptMessages) {
        if (transcriptMessage.role !== "assistant") continue;
        const taskIds = taskReplyIds(transcriptMessage.body, knownTaskIds);
        if (taskIds.length === 0) continue;
        const messageId = `transcript:${agentId}:${transcriptMessage.id}`;
        records.push({
          message: {
            id: messageId,
            from: agentId,
            to: "task",
            body: transcriptMessage.body,
            createdAt: transcriptMessage.createdAt ?? new Date().toISOString(),
          },
          taskIds,
        });
      }

      if (records.length === 0) return current;

      let changed = false;
      const newMessages = records
        .map((record) => record.message)
        .filter((message) => {
          if (existingMessageIds.has(message.id)) return false;
          changed = true;
          existingMessageIds.add(message.id);
          return true;
        });

      const nextTasks = current.tasks.map((task) => {
        const taskRecords = records.filter((record) => record.taskIds.includes(task.id));
        if (taskRecords.length === 0) return task;

        const newLinkedMessages = taskRecords
          .map((record) => record.message.id)
          .filter((messageId) => !task.linkedMessageIds.includes(messageId));
        if (newLinkedMessages.length === 0) return task;

        changed = true;
        const comments = taskRecords
          .filter((record) => newLinkedMessages.includes(record.message.id))
          .map((record) => ({
            id: `comment-${record.message.id}`,
            author: agent?.label ?? agentId,
            body: `Replied: ${snippetTitle(record.message.body)}`,
            createdAt: record.message.createdAt,
          }));
        const lastActivityAt = comments[0]?.createdAt ?? new Date().toISOString();

        return {
          ...task,
          status: task.status === "backlog" || task.status === "active" ? "review" : task.status,
          linkedMessageIds: uniqueValues([...task.linkedMessageIds, ...newLinkedMessages]),
          activeAgentIds: uniqueValues([...task.activeAgentIds, agentId]),
          comments: [...comments, ...task.comments],
          lastAgentActivityAt: lastActivityAt,
          updatedAt: lastActivityAt,
        };
      });

      if (!changed) return current;

      const normalized = persistActiveRoom(normalizeLoadedState({
        ...current,
        messages: [...newMessages, ...current.messages],
        tasks: nextTasks,
      }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save task transcript activity:", error),
      );
      return normalized;
    });
  }, [selectedAgentId]);

  const ready = fleetState !== null && runtimeContext !== null;
  const selectedAgent =
    fleetState?.agents.find((agent) => agent.id === selectedAgentId) ?? fleetState?.agents[0] ?? null;
  const visibleAgents = fleetState?.agents ?? [];
  const selectAgent = (id: string) => {
    setSelectedAgentId(id);
    setManualRecipient(id);
    setIsEditAgentOpen(false);
  };
  const openAgentDetails = (id: string) => {
    selectAgent(id);
    setIsAgentDetailsOpen(true);
  };
  const resizeAgentPane = useCallback((paneKey: string, size: AgentPaneSize | null) => {
    setAgentPaneSizes((current) => {
      if (!size) {
        const { [paneKey]: _removed, ...rest } = current;
        return rest;
      }
      return {
        ...current,
        [paneKey]: size,
      };
    });
  }, []);
  const moveAgentPane = useCallback((draggedId: string, targetId: string) => {
    setFleetState((current) => {
      if (!current || draggedId === targetId) return current;
      const fromIndex = current.agents.findIndex((agent) => agent.id === draggedId);
      const toIndex = current.agents.findIndex((agent) => agent.id === targetId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const agents = [...current.agents];
      const [draggedAgent] = agents.splice(fromIndex, 1);
      agents.splice(toIndex, 0, draggedAgent);
      const normalized = persistActiveRoom(normalizeLoadedState({ ...current, agents }), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save agent pane order:", error),
      );
      return normalized;
    });
    setDragOverAgentId(targetId);
  }, [selectedAgentId]);
  const finishAgentPaneDrag = useCallback(() => {
    setDraggingAgentId(null);
    setDragOverAgentId(null);
    setFleetState((current) => {
      if (!current) return current;
      const normalized = persistActiveRoom(normalizeLoadedState(current), selectedAgentId);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save agent pane order:", error),
      );
      return normalized;
    });
  }, [selectedAgentId]);
  const moveWorkspace = useCallback((draggedRoomId: string, targetRoomId: string) => {
    setFleetState((current) => {
      if (!current || draggedRoomId === targetRoomId) return current;
      const persisted = persistActiveRoom(normalizeLoadedState(current), selectedAgentId);
      const fromIndex = persisted.rooms.findIndex((room) => room.id === draggedRoomId);
      const toIndex = persisted.rooms.findIndex((room) => room.id === targetRoomId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
      const rooms = [...persisted.rooms];
      const [draggedRoom] = rooms.splice(fromIndex, 1);
      rooms.splice(toIndex, 0, draggedRoom);
      const normalized = normalizeLoadedState({
        ...persisted,
        rooms,
        roomOrder: rooms.map((room) => room.id),
      });
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save workspace order:", error),
      );
      return normalized;
    });
    setDragOverWorkspaceId(targetRoomId);
  }, [selectedAgentId]);
  const finishWorkspaceDrag = useCallback(() => {
    setDraggingWorkspaceId(null);
    setDragOverWorkspaceId(null);
    setFleetState((current) => {
      if (!current) return current;
      const normalized = normalizeLoadedState(current);
      appInvoke("save_fleet_state", { state: normalized }).catch((error) =>
        console.error("Failed to save workspace order:", error),
      );
      return normalized;
    });
  }, []);
  const quickOpenEntries = useMemo<QuickOpenEntry[]>(() => {
    if (!fleetState) return [];
    const entries: QuickOpenEntry[] = [
      {
        id: "command:new-room",
        kind: "command",
        title: "New workspace",
        subtitle: "Open or create another workspace",
        keywords: ["workspace", "project", "create"],
        run: startNewRoom,
      },
    ];

    if (fleetState.activeWorkspace) {
      entries.push(
        {
          id: "command:add-agent",
          kind: "command",
          title: "Add agent",
          subtitle: "Add another project-local agent to this workspace",
          keywords: ["claude", "codex", "project"],
          run: () => setIsAddAgentOpen(true),
        },
        {
          id: "command:toggle-focus",
          kind: "command",
          title: isFocusMode ? "Exit focus mode" : "Focus selected agent",
          subtitle: selectedAgent ? selectedAgent.label : "Choose an agent first",
          keywords: ["zoom", "pane", "terminal", "chat"],
          run: () => {
            if (selectedAgent) setIsFocusMode((value) => !value);
          },
        },
      );
    }

    for (const room of fleetState.rooms) {
      entries.push({
        id: `room:${room.id}`,
        kind: "room",
        title: room.workspace.name,
        subtitle: `${room.agents.length} agent${room.agents.length === 1 ? "" : "s"} · ${shortPath(room.workspace.path)}`,
        keywords: [room.workspace.path, ...room.agents.map((agent) => agent.label)],
        run: () => switchRoom(room.id),
      });
    }

    for (const agent of fleetState.agents) {
      entries.push({
        id: `agent:${agent.id}`,
        kind: "agent",
        title: agent.label,
        subtitle: `${agent.role} · ${agent.runtime} · ${shortPath(agent.cwd)}`,
        keywords: [agent.id, agent.role, agent.runtime, agent.cwd ?? ""],
        run: () => selectAgent(agent.id),
      });
    }

    for (const message of fleetState.messages.slice(0, 12)) {
      const targetAgentId = fleetState.agents.some((agent) => agent.id === message.to)
        ? message.to
        : fleetState.agents.some((agent) => agent.id === message.from)
          ? message.from
          : null;
      entries.push({
        id: `message:${message.id}`,
        kind: "message",
        title: message.body,
        subtitle: `${message.from} to ${message.to}${formatTime(message.createdAt) ? ` at ${formatTime(message.createdAt)}` : ""}`,
        keywords: [message.from, message.to, message.body],
        run: () => {
          if (targetAgentId) selectAgent(targetAgentId);
        },
      });
    }

    return entries;
  }, [fleetState, isFocusMode, selectedAgent]);

  if (!ready) {
    return (
      <main className="loading-screen">
        <span>loading fleet...</span>
      </main>
    );
  }

  if (!fleetState.activeWorkspace) {
    return (
      <>
        <WorkspaceSetup
          path={setupPath}
          name={setupName}
          error={setupError}
          onPathChange={setSetupPath}
          onNameChange={setSetupName}
          onOpen={openWorkspace}
          onCreate={createWorkspace}
          onBrowse={browseSetupPath}
        />
        <QuickOpen
          open={isQuickOpenOpen}
          entries={quickOpenEntries}
          onClose={() => setIsQuickOpenOpen(false)}
        />
      </>
    );
  }

  return (
    <main className={`app-shell bridge-shell ${isFocusMode ? "is-focus-mode" : ""}`}>
      <aside className="bridge-rail" aria-label="AgentSpace navigation">
        <div className="bridge-brand">
          <strong>AgentSpace</strong>
          <span>local context federation</span>
        </div>

        <section className="workspace-list-block">
          <div className="sidebar-heading">
            <span>Workspaces</span>
            <small>{fleetState.rooms.length}</small>
          </div>
          <div className="workspace-list" aria-label="Workspace list">
            {fleetState.rooms.map((room) => (
              <div
                className={[
                  "workspace-row",
                  room.id === fleetState.activeRoomId ? "is-active" : "",
                  draggingWorkspaceId === room.id ? "is-dragging" : "",
                  dragOverWorkspaceId === room.id ? "is-drag-over" : "",
                ].filter(Boolean).join(" ")}
                key={room.id}
              >
                <button
                  className="workspace-row-main"
                  draggable
                  onClick={() => switchRoom(room.id)}
                  onDragEnd={finishWorkspaceDrag}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (draggingWorkspaceId) moveWorkspace(draggingWorkspaceId, room.id);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={(event) => {
                    setDraggingWorkspaceId(room.id);
                    setDragOverWorkspaceId(room.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", room.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const draggedId = draggingWorkspaceId ?? event.dataTransfer.getData("text/plain");
                    if (draggedId) moveWorkspace(draggedId, room.id);
                    finishWorkspaceDrag();
                  }}
                  type="button"
                >
                  <span>
                    <strong>{room.workspace.name}</strong>
                    <small>{shortPath(room.workspace.path)}</small>
                  </span>
                  <code className="workspace-count">{room.agents.length}</code>
                </button>
                <span className="workspace-row-actions" aria-label={`${room.workspace.name} actions`}>
                  <button
                    className="workspace-row-action"
                    onClick={() => openAddAgentForRoom(room.id)}
                    title={`Add agent to ${room.workspace.name}`}
                    type="button"
                    aria-label={`Add agent to ${room.workspace.name}`}
                  >
                    +
                  </button>
                  <button
                    className="workspace-row-action is-danger"
                    onClick={() => removeWorkspace(room.id)}
                    title={`Delete ${room.workspace.name} workspace`}
                    type="button"
                    aria-label={`Delete ${room.workspace.name} workspace`}
                  >
                    x
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>

        <div className="rail-actions">
          <button className="btn wide" onClick={resetRoom}>New workspace</button>
          <button className="btn wide" onClick={() => setIsQuickOpenOpen(true)}>Quick open</button>
        </div>

        <div className="mailbox-root" title={mailboxRoot ?? "mailbox unavailable"}>
          <span>Mailbox</span>
          <code>{mailboxRoot ? shortPath(mailboxRoot) : "mailbox unavailable"}</code>
        </div>
      </aside>

      <section className="room-workbench">
        <section className="terminal-stage" aria-label="Agent panes">
          {visibleAgents.length > 0 ? (
            <div className={`agent-grid ${isFocusMode ? "is-focused" : ""}`}>
              {visibleAgents.map((agent) => {
                const roomId = fleetState.activeRoomId ?? fleetState.activeWorkspace?.id ?? "room";
                const ptyId = scopedAgentId(roomId, agent.id);
                const paneKey = `${roomId}:${agent.id}`;
                const paneStatus = agentPaneStatus(agent, ptyId, ptyStatuses);
                return (
                  <ProjectAgentPane
                    key={`${fleetState.activeRoomId ?? "room"}:${agent.id}`}
                    roomId={roomId}
                    agent={agent}
                    status={paneStatus}
                    selected={agent.id === selectedAgent?.id}
                    focused={isFocusMode && agent.id === selectedAgent?.id}
                    runtimeContext={runtimeContext}
                    allAgents={fleetState.agents}
                    shouldResume={hasUsableSession(agent)}
                    paneSize={agentPaneSizes[paneKey]}
                    dragging={draggingAgentId === agent.id}
                    dragOver={dragOverAgentId === agent.id}
                    appInvoke={appInvoke}
                    onSelect={selectAgent}
                    onOpenDetails={openAgentDetails}
                    onFocus={(id) => {
                      if (isFocusMode && id === selectedAgent?.id) {
                        setIsFocusMode(false);
                      } else {
                        selectAgent(id);
                        setIsFocusMode(true);
                      }
                    }}
                    onPaneResize={(size) => resizeAgentPane(paneKey, size)}
                    onPaneDragStart={setDraggingAgentId}
                    onPaneDragMove={moveAgentPane}
                    onPaneDragEnd={finishAgentPaneDrag}
                    onPrepareClaudeSession={prepareClaudeSession}
                    onTerminalStarted={markAgentTerminalStarted}
                    onTranscriptSession={markAgentTranscriptSession}
                    onTranscriptMessages={recordTranscriptTaskMessages}
                    onSendMessage={sendAgentMessage}
                    onFreshRestart={restartAgentFresh}
                  />
                );
              })}
            </div>
          ) : (
            <div className="empty-note">No agents in this workspace yet.</div>
          )}
        </section>
      </section>

      {isAddAgentOpen ? (
        <AddAgentModal
          name={newAgentName}
          role={newAgentRole}
          runtime={newAgentRuntime}
          path={newAgentPath}
          onNameChange={setNewAgentName}
          onRoleChange={setNewAgentRole}
          onRuntimeChange={setNewAgentRuntime}
          onPathChange={setNewAgentPath}
          onBrowse={browseAgentPath}
          onClose={() => setIsAddAgentOpen(false)}
          onAdd={addAgent}
        />
      ) : null}
      {isEditAgentOpen && selectedAgent ? (
        <EditAgentModal
          agent={selectedAgent}
          canRemove={fleetState.agents.length > 1}
          onAgentUpdate={updateAgent}
          onRemoveAgent={(id) => {
            removeAgent(id);
            setIsEditAgentOpen(false);
          }}
          onClose={() => setIsEditAgentOpen(false)}
        />
      ) : null}
      {isAgentDetailsOpen ? (
        <AgentDetailsModal
          agent={selectedAgent}
          agents={fleetState.agents}
          messages={fleetState.messages}
          manualRecipient={manualRecipient}
          manualMessage={manualMessage}
          manualError={manualError}
          isSendingMessage={isSendingMessage}
          onManualRecipientChange={setManualRecipient}
          onManualMessageChange={setManualMessage}
          onSendManualMessage={sendManualMessage}
          onEditAgent={() => {
            setIsAgentDetailsOpen(false);
            setIsEditAgentOpen(true);
          }}
          onClose={() => setIsAgentDetailsOpen(false)}
        />
      ) : null}
      {isWorkspaceModalOpen ? (
        <WorkspaceModal
          path={setupPath}
          name={setupName}
          error={setupError}
          onPathChange={setSetupPath}
          onNameChange={setSetupName}
          onOpen={openWorkspace}
          onCreate={createWorkspace}
          onBrowse={browseSetupPath}
          onClose={() => {
            setIsWorkspaceModalOpen(false);
            setSetupError(null);
          }}
        />
      ) : null}
      <QuickOpen
        open={isQuickOpenOpen}
        entries={quickOpenEntries}
        onClose={() => setIsQuickOpenOpen(false)}
      />
    </main>
  );
}

function normalizeTasks(tasks: LegacyTaskRecord[] | undefined): LegacyTaskRecord[] {
  return (tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title || "Untitled task",
    body: task.body ?? "",
    status: normalizeStatus(task.status),
    assignee: task.assignee ?? null,
    sourceMessageId: task.sourceMessageId ?? null,
    linkedMessageIds: task.linkedMessageIds ?? [],
    activeAgentIds: task.activeAgentIds ?? (task.assignee ? [task.assignee] : []),
    lastAgentActivityAt: task.lastAgentActivityAt ?? null,
    subtasks: (task.subtasks ?? []).map((subtask) => ({
      id: subtask.id,
      title: subtask.title || "Untitled subtask",
      status: normalizeStatus(subtask.status),
      assignee: subtask.assignee ?? null,
      createdBy: subtask.createdBy ?? "agent",
      createdAt: subtask.createdAt ?? new Date().toISOString(),
      updatedAt: subtask.updatedAt ?? subtask.createdAt ?? new Date().toISOString(),
    })),
    issues: (task.issues ?? []).map((issue) => ({
      id: issue.id,
      title: issue.title || "Untitled issue",
      body: issue.body ?? "",
      severity: ["low", "medium", "high", "critical"].includes(issue.severity)
        ? issue.severity
        : "medium",
      status: issue.status === "resolved" ? "resolved" : "open",
      agentId: issue.agentId ?? null,
      createdAt: issue.createdAt ?? new Date().toISOString(),
      updatedAt: issue.updatedAt ?? issue.createdAt ?? new Date().toISOString(),
    })),
    role: task.role ?? null,
    ownedFiles: task.ownedFiles ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    dependsOn: task.dependsOn ?? [],
    reviewNotes: task.reviewNotes ?? null,
    swarmId: task.swarmId ?? null,
    comments: task.comments ?? [],
    createdAt: task.createdAt ?? new Date().toISOString(),
    updatedAt: task.updatedAt ?? task.createdAt ?? new Date().toISOString(),
  }));
}

function normalizeAutomations(automations: AutomationRecord[] | undefined): AutomationRecord[] {
  return (automations ?? []).map((automation) => ({
    id: automation.id,
    name: automation.name || "Untitled automation",
    enabled: automation.enabled ?? true,
    target: {
      mode: automation.target?.mode === "room" ? "room" : "agent",
      agentIds: automation.target?.agentIds ?? [],
    },
    prompt: automation.prompt ?? "",
    schedule: {
      kind: automation.schedule?.kind ?? "manual",
      expression: automation.schedule?.expression ?? null,
      timezone: automation.schedule?.timezone ?? "UTC",
    },
    attachToTaskId: automation.attachToTaskId ?? null,
    createdAt: automation.createdAt ?? new Date().toISOString(),
    updatedAt: automation.updatedAt ?? automation.createdAt ?? new Date().toISOString(),
  }));
}

function normalizeAutomationRuns(runs: AutomationRunRecord[] | undefined): AutomationRunRecord[] {
  return (runs ?? []).map((run) => ({
    id: run.id,
    automationId: run.automationId,
    status: run.status ?? "done",
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    outputMessageIds: run.outputMessageIds ?? [],
    error: run.error ?? null,
  }));
}

function normalizeAgents(agents: AgentRecord[], workspacePath: string | null): AgentRecord[] {
  return agents.map((agent, index) => {
    const isLegacyOrchestrator = agent.id === "orchestrator" || agent.role === "orchestrator";
    const runtime = agent.runtime ?? "claude";
    const validSessionId = agent.sessionId && sessionIdPattern.test(agent.sessionId) ? agent.sessionId : null;
    const status = runtime === "claude" && !validSessionId ? "idle" : agent.status || "idle";
    return {
      ...agent,
      id: agent.id,
      label: isLegacyOrchestrator ? "home-project" : agent.label,
      accentColor: agent.accentColor ?? defaultAgentColor(index),
      title: agent.title ?? null,
      runtime,
      role: isLegacyOrchestrator ? "project expert" : agent.role || "project expert",
      reportsTo: null,
      capabilities:
        agent.capabilities ??
        `Local expert for ${agent.cwd ?? workspacePath ?? "this project"}.`,
      cwd: agent.cwd ?? workspacePath,
      worktree: agent.worktree ?? null,
      instructions: agent.instructions ?? "",
      instructionsBundle: agent.instructionsBundle ?? null,
      runtimeConfig: agent.runtimeConfig ?? { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canManageTasks: false },
      sourceTaskId: null,
      sessionId: validSessionId,
      status,
    };
  });
}

function normalizeRoom(room: RoomRecord): RoomRecord {
  const agents = normalizeAgents(room.agents ?? [], room.workspace.path);
  return {
    ...room,
    id: room.id || room.workspace.id,
    workspace: room.workspace,
    mainAgentId:
      room.mainAgentId && agents.some((agent) => agent.id === room.mainAgentId)
        ? room.mainAgentId
        : agents[0]?.id ?? null,
    agents,
    tasks: normalizeTasks(room.tasks),
    orchestratorChat: [],
    messages: room.messages ?? [],
    runs: [],
    automations: normalizeAutomations(room.automations),
    automationRuns: normalizeAutomationRuns(room.automationRuns),
    workspaces: room.workspaces ?? [],
    selectedAgentId:
      room.selectedAgentId && agents.some((agent) => agent.id === room.selectedAgentId)
        ? room.selectedAgentId
        : agents[0]?.id ?? null,
    createdAt: room.createdAt ?? room.workspace.createdAt,
    updatedAt: room.updatedAt ?? room.workspace.createdAt,
  };
}

function snapshotActiveRoom(
  state: FleetState,
  selectedAgentId?: string | null,
  updatedAt?: string,
): RoomRecord | null {
  if (!state.activeWorkspace) return null;
  return normalizeRoom({
    id: state.activeRoomId ?? state.activeWorkspace.id,
    workspace: state.activeWorkspace,
    mainAgentId: state.mainAgentId,
    agents: state.agents,
    tasks: state.tasks,
    orchestratorChat: state.orchestratorChat,
    messages: state.messages,
    runs: state.runs,
    automations: state.automations,
    automationRuns: state.automationRuns,
    workspaces: state.workspaces,
    selectedAgentId: selectedAgentId ?? state.mainAgentId ?? state.agents[0]?.id ?? null,
    createdAt: state.activeWorkspace.createdAt,
    updatedAt: updatedAt ?? state.activeWorkspace.createdAt,
  });
}

function upsertRoom(rooms: RoomRecord[], room: RoomRecord): RoomRecord[] {
  const existingIndex = rooms.findIndex((item) => item.id === room.id);
  if (existingIndex === -1) return [...rooms, room];
  return rooms.map((item, index) => (index === existingIndex ? room : item));
}

function roomCreatedAtValue(room: RoomRecord) {
  const parsed = Date.parse(room.createdAt ?? room.workspace.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function orderedRoomIds(rooms: RoomRecord[], roomOrder: string[] | undefined): string[] {
  const knownIds = new Set(rooms.map((room) => room.id));
  const seen = new Set<string>();
  const ordered = (roomOrder ?? []).filter((id) => {
    if (!knownIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const missing = rooms
    .filter((room) => !seen.has(room.id))
    .sort((a, b) => roomCreatedAtValue(a) - roomCreatedAtValue(b) || a.id.localeCompare(b.id))
    .map((room) => room.id);
  return [...ordered, ...missing];
}

function orderRooms(rooms: RoomRecord[], roomOrder: string[] | undefined) {
  const order = orderedRoomIds(rooms, roomOrder);
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  return {
    rooms: order.map((id) => roomById.get(id)).filter((room): room is RoomRecord => Boolean(room)),
    roomOrder: order,
  };
}

function persistActiveRoom(state: FleetState, selectedAgentId?: string | null): FleetState {
  const snapshot = snapshotActiveRoom(state, selectedAgentId, new Date().toISOString());
  if (!snapshot) return state;
  const ordered = orderRooms(upsertRoom(state.rooms ?? [], snapshot), state.roomOrder);
  return {
    ...state,
    activeRoomId: snapshot.id,
    rooms: ordered.rooms,
    roomOrder: ordered.roomOrder,
  };
}

function applyRoomToState(state: FleetState, room: RoomRecord): FleetState {
  const normalizedRoom = normalizeRoom(room);
  const ordered = orderRooms(upsertRoom(state.rooms ?? [], normalizedRoom), state.roomOrder);
  return normalizeLoadedState({
    ...state,
    activeRoomId: normalizedRoom.id,
    activeWorkspace: normalizedRoom.workspace,
    mainAgentId: normalizedRoom.mainAgentId,
    agents: normalizedRoom.agents,
    tasks: normalizedRoom.tasks,
    orchestratorChat: normalizedRoom.orchestratorChat,
    messages: normalizedRoom.messages,
    runs: normalizedRoom.runs,
    automations: normalizedRoom.automations,
    automationRuns: normalizedRoom.automationRuns,
    workspaces: normalizedRoom.workspaces,
    rooms: ordered.rooms,
    roomOrder: ordered.roomOrder,
  });
}

function normalizeLoadedState(state: FleetState): FleetState {
  const savedRooms = (state.rooms ?? []).map(normalizeRoom);
  const savedRoomOrder = orderedRoomIds(savedRooms, state.roomOrder);
  const orderedSavedRooms = orderRooms(savedRooms, savedRoomOrder).rooms;
  const activeRoomId = state.activeRoomId ?? state.activeWorkspace?.id ?? orderedSavedRooms[0]?.id ?? null;
  const savedActiveRoom = orderedSavedRooms.find((room) => room.id === activeRoomId) ?? null;
  const activeWorkspace = state.activeWorkspace ?? savedActiveRoom?.workspace ?? null;
  const workspacePath = activeWorkspace?.path ?? null;
  const sourceAgents = state.activeWorkspace ? state.agents : savedActiveRoom?.agents ?? state.agents;
  const sourceTasks = state.activeWorkspace ? state.tasks : savedActiveRoom?.tasks ?? state.tasks;
  const sourceMessages = state.activeWorkspace ? state.messages : savedActiveRoom?.messages ?? state.messages;
  const sourceAutomations = state.activeWorkspace ? state.automations : savedActiveRoom?.automations ?? state.automations;
  const sourceAutomationRuns = state.activeWorkspace
    ? state.automationRuns
    : savedActiveRoom?.automationRuns ?? state.automationRuns;
  const sourceWorkspaces = state.activeWorkspace ? state.workspaces : savedActiveRoom?.workspaces ?? state.workspaces;
  const preferredMainAgentId = state.mainAgentId ?? savedActiveRoom?.mainAgentId ?? null;
  const agents = normalizeAgents(sourceAgents ?? [], workspacePath);
  const tasks = normalizeTasks(sourceTasks);
  const automations = normalizeAutomations(sourceAutomations);
  const automationRuns = normalizeAutomationRuns(sourceAutomationRuns);
  const activeSelectedAgentId = savedActiveRoom?.selectedAgentId ?? state.mainAgentId;
  const activeSnapshot = snapshotActiveRoom(
    {
      ...state,
      activeRoomId,
      activeWorkspace,
      agents,
      tasks,
      orchestratorChat: [],
      messages: sourceMessages ?? [],
      runs: [],
      automations,
      automationRuns,
      workspaces: sourceWorkspaces ?? [],
      rooms: orderedSavedRooms,
    },
    activeSelectedAgentId,
  );
  const ordered = orderRooms(
    activeSnapshot ? upsertRoom(orderedSavedRooms, activeSnapshot) : orderedSavedRooms,
    savedRoomOrder,
  );

  return {
    ...state,
    schemaVersion: 5,
    activeRoomId,
    rooms: ordered.rooms,
    roomOrder: ordered.roomOrder,
    mainAgentId:
      preferredMainAgentId && agents.some((agent) => agent.id === preferredMainAgentId)
        ? preferredMainAgentId
        : agents[0]?.id ?? null,
    activeWorkspace,
    agents,
    tasks,
    orchestratorChat: [],
    messages: sourceMessages ?? [],
    runs: [],
    automations,
    automationRuns,
    workspaces: sourceWorkspaces ?? [],
  };
}

function AgentDetailsModal({
  agent,
  agents,
  messages,
  manualRecipient,
  manualMessage,
  manualError,
  isSendingMessage,
  onManualRecipientChange,
  onManualMessageChange,
  onSendManualMessage,
  onEditAgent,
  onClose,
}: {
  agent: AgentRecord | null;
  agents: AgentRecord[];
  messages: MessageRecord[];
  manualRecipient: string;
  manualMessage: string;
  manualError: string | null;
  isSendingMessage: boolean;
  onManualRecipientChange: (value: string) => void;
  onManualMessageChange: (value: string) => void;
  onSendManualMessage: () => void;
  onEditAgent: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="agent-modal agent-details-modal" role="dialog" aria-modal="true" aria-labelledby="agent-details-title">
        <header className="modal-header">
          <div>
            <h2 id="agent-details-title">{agent ? agent.label : "Agent details"}</h2>
            <p>{agent ? agent.role : "Choose an agent to inspect, message, or edit."}</p>
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close agent details dialog">
            Close
          </button>
        </header>

        <AgentDetails
          agent={agent}
          agents={agents}
          messages={messages}
          manualRecipient={manualRecipient}
          manualMessage={manualMessage}
          manualError={manualError}
          isSendingMessage={isSendingMessage}
          onManualRecipientChange={onManualRecipientChange}
          onManualMessageChange={onManualMessageChange}
          onSendManualMessage={onSendManualMessage}
          onEditAgent={onEditAgent}
        />
      </section>
    </div>
  );
}

function AgentDetails({
  agent,
  agents,
  messages,
  manualRecipient,
  manualMessage,
  manualError,
  isSendingMessage,
  onManualRecipientChange,
  onManualMessageChange,
  onSendManualMessage,
  onEditAgent,
}: {
  agent: AgentRecord | null;
  agents: AgentRecord[];
  messages: MessageRecord[];
  manualRecipient: string;
  manualMessage: string;
  manualError: string | null;
  isSendingMessage: boolean;
  onManualRecipientChange: (value: string) => void;
  onManualMessageChange: (value: string) => void;
  onSendManualMessage: () => void;
  onEditAgent: () => void;
}) {
  return (
    <>
      <section className="panel-section">
        <div className="section-title">Agent</div>
        {agent ? (
          <div className="agent-summary-card">
            <div>
              <strong>{agent.label}</strong>
              <span>{agent.role}</span>
              <code title={agent.cwd ?? undefined}>{shortPath(agent.cwd)}</code>
            </div>
            <button className="btn wide" onClick={onEditAgent}>Edit agent</button>
          </div>
        ) : (
          <div className="empty-note">No agent selected.</div>
        )}
      </section>

      <section className="panel-section">
        <div className="section-title">Send Message</div>
        <div className="details-stack">
          <label>
            <span>Recipient</span>
            <select value={manualRecipient} onChange={(event) => onManualRecipientChange(event.target.value)}>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Message</span>
            <textarea
              value={manualMessage}
              placeholder="Ask for the contract, risk, file owner, or decision."
              onChange={(event) => onManualMessageChange(event.target.value)}
            />
          </label>
          {manualError ? <div className="inline-error">{manualError}</div> : null}
          <button
            className="btn primary wide"
            disabled={!manualMessage.trim() || !manualRecipient || isSendingMessage}
            onClick={onSendManualMessage}
          >
            {isSendingMessage ? "Sending..." : "Send to agent"}
          </button>
        </div>
      </section>

      <section className="panel-section">
        <div className="section-title">Message Ledger</div>
        <div className="message-ledger">
          {messages.slice(0, 14).map((message) => (
            <div className="ledger-item" key={message.id}>
              <div className="ledger-item-header">
                <span>{message.from} to {message.to}{formatTime(message.createdAt) ? ` at ${formatTime(message.createdAt)}` : ""}</span>
              </div>
              <p>{message.body}</p>
            </div>
          ))}
          {messages.length === 0 ? <div className="empty-note">No messages yet.</div> : null}
        </div>
      </section>
    </>
  );
}

function EditAgentModal({
  agent,
  canRemove,
  onAgentUpdate,
  onRemoveAgent,
  onClose,
}: {
  agent: AgentRecord;
  canRemove: boolean;
  onAgentUpdate: (id: string, patch: Partial<AgentRecord>) => void;
  onRemoveAgent: (id: string) => void;
  onClose: () => void;
}) {
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="edit-agent-title">
        <header className="modal-header">
          <div>
            <h2 id="edit-agent-title">Edit agent</h2>
            <p>Keep this project-local agent easy to route and understand.</p>
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close edit agent dialog">
            Close
          </button>
        </header>

        <form className="modal-form" onSubmit={submit}>
          <label>
            Name
            <input
              autoFocus
              value={agent.label}
              onChange={(event) => onAgentUpdate(agent.id, { label: event.target.value })}
            />
          </label>
          <label>
            Role
            <input
              value={agent.role}
              onChange={(event) => onAgentUpdate(agent.id, { role: event.target.value })}
            />
          </label>
          <label>
            Project path
            <input
              value={agent.cwd ?? ""}
              onChange={(event) => onAgentUpdate(agent.id, { cwd: event.target.value })}
            />
          </label>
          <label>
            Local expertise
            <textarea
              value={agent.capabilities ?? ""}
              placeholder="What does this project agent know?"
              onChange={(event) => onAgentUpdate(agent.id, { capabilities: event.target.value || null })}
            />
          </label>
          <label>
            Standing instructions
            <textarea
              value={agent.instructions ?? ""}
              placeholder="Optional"
              onChange={(event) => onAgentUpdate(agent.id, { instructions: event.target.value })}
            />
          </label>
          <div className="modal-actions edit-actions">
            <button
              className="btn danger"
              disabled={!canRemove}
              onClick={() => onRemoveAgent(agent.id)}
              type="button"
            >
              Remove
            </button>
            <button className="btn" onClick={onClose} type="button">Cancel</button>
            <button className="btn primary" type="submit">Done</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AddAgentModal({
  name,
  role,
  runtime,
  path,
  onNameChange,
  onRoleChange,
  onRuntimeChange,
  onPathChange,
  onBrowse,
  onClose,
  onAdd,
}: {
  name: string;
  role: string;
  runtime: AgentRuntime;
  path: string;
  onNameChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onRuntimeChange: (value: AgentRuntime) => void;
  onPathChange: (value: string) => void;
  onBrowse: () => void;
  onClose: () => void;
  onAdd: () => void;
}) {
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (path.trim()) onAdd();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="add-agent-title">
        <header className="modal-header">
          <div>
            <h2 id="add-agent-title">Add project agent</h2>
            <p>Choose a project directory and give the agent a local role.</p>
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close add agent dialog">
            Close
          </button>
        </header>

        <form className="modal-form" onSubmit={submit}>
          <label>
            Name
            <input
              autoFocus
              value={name}
              placeholder="billing-service"
              onChange={(event) => onNameChange(event.target.value)}
            />
          </label>
          <label>
            Role
            <input
              value={role}
              placeholder="service expert"
              onChange={(event) => onRoleChange(event.target.value)}
            />
          </label>
          <label>
            Runtime
            <select
              value={runtime}
              onChange={(event) => onRuntimeChange(event.target.value as AgentRuntime)}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Project path
            <input
              value={path}
              placeholder="/path/to/project"
              onChange={(event) => onPathChange(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={onBrowse} type="button">Browse</button>
            <button className="btn" onClick={onClose} type="button">Cancel</button>
            <button className="btn primary" disabled={!path.trim()} type="submit">Add agent</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function WorkspaceModal({
  path,
  name,
  error,
  onPathChange,
  onNameChange,
  onOpen,
  onCreate,
  onBrowse,
  onClose,
}: {
  path: string;
  name: string;
  error: string | null;
  onPathChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onOpen: () => void;
  onCreate: () => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="agent-modal workspace-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title">
        <header className="modal-header">
          <div>
            <h2 id="workspace-modal-title">New workspace</h2>
            <p>Open an existing project folder or create a workspace directory.</p>
          </div>
          <button className="modal-close" onClick={onClose} type="button" aria-label="Close workspace dialog">
            Close
          </button>
        </header>

        <WorkspaceForm
          path={path}
          name={name}
          error={error}
          onPathChange={onPathChange}
          onNameChange={onNameChange}
          onOpen={onOpen}
          onCreate={onCreate}
          onBrowse={onBrowse}
        />
      </section>
    </div>
  );
}

function WorkspaceSetup({
  path,
  name,
  error,
  onPathChange,
  onNameChange,
  onOpen,
  onCreate,
  onBrowse,
}: {
  path: string;
  name: string;
  error: string | null;
  onPathChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onOpen: () => void;
  onCreate: () => void;
  onBrowse: () => void;
}) {
  return (
    <main className="setup-shell">
      <section className="setup-brand">
        <div className="eyebrow">Context federation</div>
        <h1>AgentSpace</h1>
        <p>
          Choose a home project. Then add one Claude agent per project or service.
          Each agent keeps its own context warm and talks to peers through MCP messages.
        </p>
      </section>
      <section className="setup-panel">
        <WorkspaceForm
          path={path}
          name={name}
          error={error}
          onPathChange={onPathChange}
          onNameChange={onNameChange}
          onOpen={onOpen}
          onCreate={onCreate}
          onBrowse={onBrowse}
        />
      </section>
    </main>
  );
}

function WorkspaceForm({
  path,
  name,
  error,
  onPathChange,
  onNameChange,
  onOpen,
  onCreate,
  onBrowse,
}: {
  path: string;
  name: string;
  error: string | null;
  onPathChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onOpen: () => void;
  onCreate: () => void;
  onBrowse: () => void;
}) {
  return (
    <>
      <div>
        <div className="setup-title">Open workspace</div>
        <div className="setup-copy">Choose the project that anchors this workspace. Agents can still live in different projects.</div>
      </div>
      <label className="setup-field">
        Project path
        <div className="path-picker">
          <input
            className="setup-input"
            value={path}
            placeholder="~/Development/billing-service"
            onChange={(event) => onPathChange(event.target.value)}
          />
          <button className="btn" onClick={onBrowse} type="button">Browse</button>
        </div>
      </label>
      <label className="setup-field">
        Workspace name
        <input
          className="setup-input"
          value={name}
          placeholder="Optional"
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      {error ? <div className="setup-error">{error}</div> : null}
      <div className="setup-actions">
        <button className="btn primary" onClick={onOpen} type="button">Open workspace</button>
        <button className="btn btn-secondary" onClick={onCreate} type="button">Create workspace</button>
      </div>
    </>
  );
}

export default App;
