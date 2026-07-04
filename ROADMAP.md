# AgentSpace Roadmap

AgentSpace is a local workspace for context-federated agents. The core stays simple: each agent owns one project context, runs in a real terminal, and exchanges conclusions through local MCP tools and plain mailbox files.

The roadmap is about making that model feel like a durable engineering workspace without turning it into a hidden orchestrator.

## Principles

- Keep project knowledge local to the agent that lives in that project.
- Prefer explicit messages over shared hidden memory.
- Keep terminal, mailbox, and state files inspectable.
- Preserve dev/prod runtime isolation.
- Make the UI cleaner by moving secondary controls into modals and contextual pane actions.

## Phase 1: Workspace Shell

- Workspace list in the left rail.
- Stable workspace ordering with manual drag reorder.
- Agent panes as the primary work surface.
- Agent details, edit controls, and workspace creation in modals.
- Focus mode that enlarges one pane without closing other live terminals.
- Persist pane size and layout preferences.

## Phase 2: Agent Sessions

- Keep Claude and Codex runtime adapters behind a shared interface.
- Attach to existing sessions when safe.
- Resume sessions only after validating the transcript/session exists.
- Keep terminal PTYs stable across tab, focus, and layout changes.
- Surface clear recovery actions for exited or stale sessions.

## Phase 3: Chat View

- Render Claude JSONL transcripts as chat.
- Keep terminal mode available for full fidelity.
- Ensure transcript reads are scoped to the exact agent session.
- Stream transcript updates to the UI through the local watcher.
- Keep send-message behavior backed by the same PTY/MCP path.

## Phase 4: Workspace Tools

- Add file/browser/editor surfaces beside agent panes.
- Keep secondary surfaces contextual to the selected agent or workspace.
- Maintain local-only profiles for any browser or tool state.
- Support command palette entries for workspace, agent, message, and tool actions.

## Phase 5: Agent Work Graph

- Reintroduce tasks only when they serve the agent workflow.
- Let agents create, search, comment on, and update work items through MCP.
- Support subtasks and issues as lightweight local records.
- Keep every task action auditable in local state and messages.

## Phase 6: Automation

- Add local scheduled or manual automation only after the agent/session model is stable.
- Make every automation target explicit: workspace, agent, or selected work item.
- Keep automation runs visible, cancellable, and easy to inspect.

## Runtime Boundaries

- Release state: `~/.agent-space`
- Development state: `~/.agent-space-dev`
- Release socket: `/tmp/agent-space.sock`
- Development socket: `/tmp/agent-space-dev.sock`

AgentSpace should remain boring at the transport layer so the product can be ambitious at the collaboration layer.
