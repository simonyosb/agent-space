export type AgentRuntime = "claude" | "codex";

export type ProjectWorkspace = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
};

export type AgentRecord = {
  id: string;
  label: string;
  accentColor: string | null;
  title: string | null;
  runtime: AgentRuntime;
  role: string;
  reportsTo: string | null;
  capabilities: string | null;
  cwd: string | null;
  worktree: string | null;
  instructions: string | null;
  instructionsBundle: { files: Record<string, string> } | null;
  runtimeConfig: Record<string, unknown>;
  permissions: {
    canCreateAgents: boolean;
    canManageTasks: boolean;
  };
  sourceTaskId: string | null;
  sessionId: string | null;
  status: string;
};

export type MessageRecord = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
};

export type PtyStatus = {
  id: string;
  exists: boolean;
  exited: boolean;
  bufferLen: number;
};

export type AgentPaneStatus = "ready" | "resume" | "live" | "exited";

export type TaskStatus = "backlog" | "active" | "blocked" | "review" | "done";

export type TaskCommentRecord = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export type TaskSubtaskRecord = {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskIssueSeverity = "low" | "medium" | "high" | "critical";
export type TaskIssueStatus = "open" | "resolved";

export type TaskIssueRecord = {
  id: string;
  title: string;
  body: string;
  severity: TaskIssueSeverity;
  status: TaskIssueStatus;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptMessageRecord = {
  id: string;
  role: string;
  body: string;
  createdAt: string | null;
};

export type LegacyTaskRecord = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  assignee: string | null;
  sourceMessageId: string | null;
  linkedMessageIds: string[];
  activeAgentIds: string[];
  lastAgentActivityAt: string | null;
  subtasks: TaskSubtaskRecord[];
  issues: TaskIssueRecord[];
  role: string | null;
  ownedFiles: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  reviewNotes: string | null;
  swarmId: string | null;
  comments: TaskCommentRecord[];
  createdAt: string;
  updatedAt: string;
};

export type TaskUpdatePatch = Partial<
  Pick<
    LegacyTaskRecord,
    "title" | "body" | "status" | "assignee" | "acceptanceCriteria" | "reviewNotes"
  >
>;

export type AutomationTarget = {
  mode: "agent" | "room";
  agentIds: string[];
};

export type AutomationSchedule = {
  kind: "manual" | "interval" | "cron";
  expression: string | null;
  timezone: string;
};

export type AutomationRecord = {
  id: string;
  name: string;
  enabled: boolean;
  target: AutomationTarget;
  prompt: string;
  schedule: AutomationSchedule;
  attachToTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRunRecord = {
  id: string;
  automationId: string;
  status: "queued" | "running" | "failed" | "done" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  outputMessageIds: string[];
  error: string | null;
};

export type RoomRecord = {
  id: string;
  workspace: ProjectWorkspace;
  mainAgentId: string | null;
  agents: AgentRecord[];
  tasks: LegacyTaskRecord[];
  orchestratorChat: unknown[];
  messages: MessageRecord[];
  runs: unknown[];
  automations: AutomationRecord[];
  automationRuns: AutomationRunRecord[];
  workspaces: unknown[];
  selectedAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FleetState = {
  schemaVersion: number;
  activeRoomId: string | null;
  rooms: RoomRecord[];
  roomOrder: string[];
  activeWorkspace: ProjectWorkspace | null;
  mainAgentId: string | null;
  agents: AgentRecord[];
  tasks: LegacyTaskRecord[];
  orchestratorChat: unknown[];
  messages: MessageRecord[];
  runs: unknown[];
  automations: AutomationRecord[];
  automationRuns: AutomationRunRecord[];
  workspaces: unknown[];
};

export type RuntimeContext = {
  mcpBinaryPath: string;
  mcpConfigPath: string;
  fleetSocketPath: string;
  mailboxRoot: string | null;
  systemPrompt: (agentId: string) => string;
};
