use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

fn emit(value: Value) {
    let s = serde_json::to_string(&value).unwrap_or_default();
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = writeln!(lock, "{}", s);
    let _ = lock.flush();
}

fn ok(id: Option<Value>, result: Value) {
    emit(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn err(id: Option<Value>, code: i32, message: &str) {
    emit(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }));
}

fn call_bus(payload: &str) -> Result<String, String> {
    let socket = env::var("FLEET_SOCKET")
        .unwrap_or_else(|_| claude_fleet_lib::runtime_profile::socket_path().into());
    let mut stream = UnixStream::connect(&socket).map_err(|e| e.to_string())?;
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    if !payload.ends_with('\n') {
        let _ = stream.write_all(b"\n");
    }
    let _ = stream.flush();

    let mut buf = String::new();
    BufReader::new(&stream)
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf.trim().to_string())
}

fn tools_def() -> Value {
    json!({
        "tools": [
            {
                "name": "send_message",
                "description": "Send a message to another agent in the agent-space. The message will appear at the target agent's prompt prefixed with `[from <your-id>]:` and submit as a new user turn.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "to": { "type": "string", "description": "Target agent ID (use list_agents to discover available IDs)" },
                        "body": { "type": "string", "description": "Message body to deliver" }
                    },
                    "required": ["to", "body"]
                }
            },
            {
                "name": "list_agents",
                "description": "List project-local agents in the fleet, including role, runtime, status, expertise notes, and project directory.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "list_messages",
                "description": "List recent cross-agent messages. Use this as an audit trail or to recover recent handoffs.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "list_tasks",
                "description": "List room tasks, including subtasks, issues, comments, assignee, status, and task IDs.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "search_tasks",
                "description": "Search tasks by text, status, and assignee. Use before creating duplicate work.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Text to search in title, body, comments, subtasks, and issues" },
                        "status": { "type": "string", "description": "Optional status: backlog, active, blocked, review, done" },
                        "assignee": { "type": "string", "description": "Optional agent ID assigned to the task" },
                        "include_done": { "type": "boolean", "description": "Include done tasks; default false" }
                    }
                }
            },
            {
                "name": "create_task",
                "description": "Create a room task when you find durable work, a cross-project question, or a decision that should be tracked.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "assignee": { "type": "string", "description": "Optional agent ID" },
                        "acceptance_criteria": { "type": "array", "items": { "type": "string" } },
                        "owned_files": { "type": "array", "items": { "type": "string" } },
                        "depends_on": { "type": "array", "items": { "type": "string" } },
                        "review_notes": { "type": "string" }
                    },
                    "required": ["title"]
                }
            },
            {
                "name": "update_task",
                "description": "Update task status, assignee, title, body, acceptance criteria, or review notes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "status": { "type": "string", "description": "backlog, active, blocked, review, done" },
                        "assignee": { "type": "string" },
                        "acceptance_criteria": { "type": "array", "items": { "type": "string" } },
                        "owned_files": { "type": "array", "items": { "type": "string" } },
                        "depends_on": { "type": "array", "items": { "type": "string" } },
                        "review_notes": { "type": "string" }
                    },
                    "required": ["task_id"]
                }
            },
            {
                "name": "comment_task",
                "description": "Add an auditable comment to a task. Use this for findings, decisions, progress, questions, and handoff notes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "body": { "type": "string" }
                    },
                    "required": ["task_id", "body"]
                }
            },
            {
                "name": "create_subtask",
                "description": "Create a subtask under an existing task for a smaller step or per-project check.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "title": { "type": "string" },
                        "assignee": { "type": "string", "description": "Optional agent ID" }
                    },
                    "required": ["task_id", "title"]
                }
            },
            {
                "name": "update_subtask",
                "description": "Update a subtask title, status, or assignee.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "subtask_id": { "type": "string" },
                        "title": { "type": "string" },
                        "status": { "type": "string", "description": "backlog, active, blocked, review, done" },
                        "assignee": { "type": "string" }
                    },
                    "required": ["task_id", "subtask_id"]
                }
            },
            {
                "name": "create_issue",
                "description": "Create an issue under a task for a bug, risk, blocker, contradiction, or finding discovered while working.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "severity": { "type": "string", "description": "low, medium, high, critical" }
                    },
                    "required": ["task_id", "title"]
                }
            },
            {
                "name": "update_issue",
                "description": "Update an issue title, body, severity, or status.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "issue_id": { "type": "string" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "severity": { "type": "string", "description": "low, medium, high, critical" },
                        "status": { "type": "string", "description": "open or resolved" }
                    },
                    "required": ["task_id", "issue_id"]
                }
            }
        ]
    })
}

fn string_arg(arguments: &Value, name: &str) -> Option<String> {
    arguments
        .get(name)
        .and_then(|v| v.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn string_array_arg(arguments: &Value, name: &str) -> Vec<String> {
    arguments
        .get(name)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.trim().to_string()))
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn actor_id() -> String {
    env::var("FLEET_AGENT_ID").unwrap_or_else(|_| "agent".to_string())
}

fn handle(req: JsonRpcRequest) {
    match req.method.as_str() {
        "initialize" => {
            ok(
                req.id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "agent-space", "version": "0.1.0" }
                }),
            );
        }
        "tools/list" => ok(req.id, tools_def()),
        "tools/call" => {
            let params = req.params.unwrap_or(json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

            let text = match name {
                "send_message" => {
                    let to = arguments
                        .get("to")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let body = arguments
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if to.is_empty() || body.is_empty() {
                        err(req.id, -32602, "send_message requires 'to' and 'body'");
                        return;
                    }
                    let from = env::var("FLEET_AGENT_ID").ok();
                    let from_room = env::var("FLEET_ROOM_ID").ok();
                    let payload =
                        json!({ "from": from, "fromRoom": from_room, "to": to, "body": body })
                            .to_string();
                    match call_bus(&payload) {
                        Ok(resp) if resp == "ok" => format!("Message delivered to {}", to),
                        Ok(resp) => format!("Bus: {}", resp),
                        Err(e) => format!("Bus error: {}", e),
                    }
                }
                "list_agents" => claude_fleet_lib::app_state::list_agents_for_mcp()
                    .unwrap_or_else(|e| format!("State error: {}", e)),
                "list_messages" => claude_fleet_lib::app_state::list_messages_for_mcp()
                    .unwrap_or_else(|e| format!("State error: {}", e)),
                "list_tasks" => claude_fleet_lib::app_state::list_tasks_for_mcp()
                    .unwrap_or_else(|e| format!("State error: {}", e)),
                "search_tasks" => {
                    let include_done = arguments
                        .get("include_done")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    claude_fleet_lib::app_state::search_tasks_for_mcp(
                        string_arg(&arguments, "query"),
                        string_arg(&arguments, "status"),
                        string_arg(&arguments, "assignee"),
                        include_done,
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "create_task" => {
                    let title = string_arg(&arguments, "title").unwrap_or_default();
                    if title.is_empty() {
                        err(req.id, -32602, "create_task requires 'title'");
                        return;
                    }
                    claude_fleet_lib::app_state::create_task_from_mcp(
                        title,
                        string_arg(&arguments, "body"),
                        string_arg(&arguments, "assignee"),
                        None,
                        string_array_arg(&arguments, "owned_files"),
                        string_array_arg(&arguments, "acceptance_criteria"),
                        string_array_arg(&arguments, "depends_on"),
                        string_arg(&arguments, "review_notes"),
                        None,
                        actor_id(),
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "update_task" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    if task_id.is_empty() {
                        err(req.id, -32602, "update_task requires 'task_id'");
                        return;
                    }
                    claude_fleet_lib::app_state::update_task_from_mcp(
                        task_id,
                        string_arg(&arguments, "title"),
                        string_arg(&arguments, "body"),
                        string_arg(&arguments, "status"),
                        string_arg(&arguments, "assignee"),
                        None,
                        arguments.get("owned_files").map(|_| string_array_arg(&arguments, "owned_files")),
                        arguments
                            .get("acceptance_criteria")
                            .map(|_| string_array_arg(&arguments, "acceptance_criteria")),
                        arguments.get("depends_on").map(|_| string_array_arg(&arguments, "depends_on")),
                        string_arg(&arguments, "review_notes"),
                        None,
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "comment_task" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    let body = string_arg(&arguments, "body").unwrap_or_default();
                    if task_id.is_empty() || body.is_empty() {
                        err(req.id, -32602, "comment_task requires 'task_id' and 'body'");
                        return;
                    }
                    claude_fleet_lib::app_state::comment_task_from_mcp(task_id, body, actor_id())
                        .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "create_subtask" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    let title = string_arg(&arguments, "title").unwrap_or_default();
                    if task_id.is_empty() || title.is_empty() {
                        err(req.id, -32602, "create_subtask requires 'task_id' and 'title'");
                        return;
                    }
                    claude_fleet_lib::app_state::create_subtask_from_mcp(
                        task_id,
                        title,
                        string_arg(&arguments, "assignee"),
                        actor_id(),
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "update_subtask" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    let subtask_id = string_arg(&arguments, "subtask_id").unwrap_or_default();
                    if task_id.is_empty() || subtask_id.is_empty() {
                        err(req.id, -32602, "update_subtask requires 'task_id' and 'subtask_id'");
                        return;
                    }
                    claude_fleet_lib::app_state::update_subtask_from_mcp(
                        task_id,
                        subtask_id,
                        string_arg(&arguments, "title"),
                        string_arg(&arguments, "status"),
                        string_arg(&arguments, "assignee"),
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "create_issue" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    let title = string_arg(&arguments, "title").unwrap_or_default();
                    if task_id.is_empty() || title.is_empty() {
                        err(req.id, -32602, "create_issue requires 'task_id' and 'title'");
                        return;
                    }
                    claude_fleet_lib::app_state::create_issue_from_mcp(
                        task_id,
                        title,
                        string_arg(&arguments, "body"),
                        string_arg(&arguments, "severity"),
                        actor_id(),
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                "update_issue" => {
                    let task_id = string_arg(&arguments, "task_id").unwrap_or_default();
                    let issue_id = string_arg(&arguments, "issue_id").unwrap_or_default();
                    if task_id.is_empty() || issue_id.is_empty() {
                        err(req.id, -32602, "update_issue requires 'task_id' and 'issue_id'");
                        return;
                    }
                    claude_fleet_lib::app_state::update_issue_from_mcp(
                        task_id,
                        issue_id,
                        string_arg(&arguments, "title"),
                        string_arg(&arguments, "body"),
                        string_arg(&arguments, "severity"),
                        string_arg(&arguments, "status"),
                    )
                    .unwrap_or_else(|e| format!("State error: {}", e))
                }
                _ => {
                    err(req.id, -32601, &format!("Unknown tool: {}", name));
                    return;
                }
            };

            ok(
                req.id,
                json!({ "content": [{ "type": "text", "text": text }] }),
            );
        }
        m if m.starts_with("notifications/") => {}
        _ => {
            if req.id.is_some() {
                err(req.id, -32601, &format!("Unknown method: {}", req.method));
            }
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                    Ok(req) => handle(req),
                    Err(_) => {}
                }
            }
            Err(_) => break,
        }
    }
}
