# AgentSpace

AgentSpace is a local context-federation room for developers working across several codebases at once.

Instead of trying to stuff every repository into one model context, AgentSpace keeps separate long-lived Claude or Codex agents running in their own project directories. Each agent owns the context for one service, package, or app. When another project needs an answer, the agent investigates locally and sends back the useful conclusion: a contract, file reference, risk, decision, or next step.

The goal is simple: keep knowledge where it lives, and let understanding cross the wire.

See [ROADMAP.md](ROADMAP.md) for the AgentSpace direction: a local workspace built on the context-federation backend.

## Why This Exists

Modern software often spans many repos. A billing service, auth API, frontend app, worker queue, and shared package may all matter to one decision, but one chat session cannot hold all of that context well.

AgentSpace treats each project as a local expert. The user stays in control of a visible room of agents:

- Each agent runs in a real terminal/PTY pane.
- Each agent has a project directory and role.
- Agents can send messages through the local MCP bridge.
- Messages are also written as plain JSON mailbox files.
- Release state lives locally under `~/.agent-space`; development runs use `~/.agent-space-dev`.

It is not a hidden orchestrator, task-board workflow, or glossy multi-agent abstraction. It is a small desktop app around boring primitives: terminals, files, local state, helper binaries, and explicit message passing.

## Core Idea

AgentSpace is built around context federation, not shared context.

A project-local agent can read files, trace call paths, run tests, and build a mental model inside its own context window. The rest of the fleet does not need that entire raw context. It only needs the answer.

That means a frontend agent can ask an auth agent:

```text
What identifier is stable across token refresh and safe for billing joins?
```

The auth agent can inspect its own repo and reply:

```text
Use account_id. Email is mutable and subject can change across provider migrations.
```

The expensive local investigation stays local. The useful conclusion crosses the boundary.

## What It Does Today

- Opens a local Tauri desktop app.
- Lets you create a room anchored to a home project.
- Lets you add project-local Claude or Codex agents.
- Runs each agent in a terminal pane using a PTY.
- Keeps multiple panes alive in a grid.
- Supports focus mode without closing the other terminals.
- Injects a system prompt that explains the agent's project, role, and peers.
- Writes a Claude-compatible MCP config at `~/.agent-space/mcp.json`.
- Runs a local Unix socket bus at `/tmp/agent-space.sock`.
- Provides MCP tools for agent discovery and messaging.
- Records messages to `~/.agent-space/mail`.
- Ships signed macOS Apple Silicon releases with user-controlled in-app updates.

## Local Files

AgentSpace stores its runtime state outside the repo:

```text
~/.agent-space/
  state.json
  mcp.json
  mail/
    messages/
    agents/
      <agent-id>/
        inbox/
        outbox/
  agent-homes/
```

The mailbox files are intentionally plain JSON. If something breaks, you should be able to inspect it with `ls`, `cat`, and your editor.

Development builds are isolated from the installed app. `npm run tauri dev` uses `~/.agent-space-dev` and `/tmp/agent-space-dev.sock`, while release builds keep using `~/.agent-space` and `/tmp/agent-space.sock`.

## Architecture

At a high level:

```text
Tauri desktop app
  React app shell
  xterm.js terminal panes
  Rust PTY manager
  local state + mailbox writer
  Unix socket message bus
  fleet-mcp helper binary
  fleet-msg helper binary
```

Agents do not directly share context. They communicate through the MCP bridge and the local bus. The app records those messages into the mailbox ledger.

The important boundary is that an agent can spend tokens understanding its own project, but only the summarized answer has to leave that project-local context.

## MCP Tools

The bundled `fleet-mcp` binary exposes local tools to each agent. The active product surface uses:

- `list_agents` - discover peer agents and their project directories
- `send_message(to, body)` - send a message to another agent
- `list_messages` - inspect recent cross-agent messages

The app writes `~/.agent-space/mcp.json` on startup so Claude can connect to the local helper binary.

## Development

Prerequisites:

- Node/Bun-compatible JavaScript tooling
- Rust and Cargo
- Tauri dependencies for macOS
- `claude` and/or `codex` CLIs installed locally

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run tauri dev
```

Run only the Vite frontend preview:

```bash
npm run dev
```

The browser preview has a mock bridge. Real PTY sessions only run inside Tauri.

## Build

Build the frontend:

```bash
npm run build
```

Build the Tauri app bundle:

```bash
npm run tauri build -- --bundles app
```

The macOS app bundle is written to:

```text
src-tauri/target/release/bundle/macos/AgentSpace.app
```

The built macOS app adds common CLI locations such as `~/.local/bin`, `~/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` to the PTY `PATH` so agents can find locally installed CLIs when launched outside a shell.

Maintainers can follow the production signing, notarization, updater, and smoke
test process in [docs/RELEASE.md](docs/RELEASE.md).

## Current Caveats

- This is local-first desktop tooling, not a hosted product.
- The app is optimized for the developer's own machine and local CLIs.
- Public macOS releases require an Apple Developer ID certificate and notarization credentials.
- Some legacy task/orchestrator code still exists in the backend, but the current product direction is the simpler agent room: project-local terminals plus message passing.

## Philosophy

AgentSpace is intentionally boring.

The fancy part is not the transport. The fancy part is the coordination model: local expertise plus cheap communication. A confused agent should not be able to corrupt another agent's context. A user should be able to inspect every important thing. A message should be a thing you can read from disk.

This project is for the kind of developer who would rather debug with `ps`, `ls`, and a terminal than trust a black box that says the swarm is thinking.
