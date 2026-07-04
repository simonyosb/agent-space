use crate::{app_state, pty::PtyRegistry, runtime_profile};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    from: Option<String>,
    from_room: Option<String>,
    to: String,
    body: String,
}

pub fn start(registry: PtyRegistry) {
    let socket_path = runtime_profile::socket_path();
    let _ = std::fs::remove_file(socket_path);
    let listener = match UnixListener::bind(Path::new(socket_path)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agent-space: failed to bind {}: {}", socket_path, e);
            return;
        }
    };
    println!("agent-space: bus listening on {}", socket_path);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let reg = registry.clone();
                    std::thread::spawn(move || handle_conn(stream, reg));
                }
                Err(e) => eprintln!("agent-space bus accept error: {}", e),
            }
        }
    });
}

fn handle_conn(stream: UnixStream, registry: PtyRegistry) {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .ok()
            .unwrap_or_else(|| stream.try_clone().unwrap()),
    );
    let mut writer = stream;
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }

    if line.trim() == "list" {
        let ids = registry.agent_ids().join("\n");
        let _ = writeln!(writer, "{}", ids);
        return;
    }

    let env: Envelope = match serde_json::from_str(line.trim()) {
        Ok(e) => e,
        Err(e) => {
            let _ = writeln!(writer, "error: invalid json: {}", e);
            return;
        }
    };

    let sender = env.from.unwrap_or_else(|| "unknown".to_string());
    let body = format!("[from {}]: {}", sender, env.body);
    if let Err(e) = registry.write_to_agent(env.from_room.as_deref(), &env.to, body.as_bytes()) {
        let _ = writeln!(writer, "error: {}", e);
        return;
    }
    let _ = app_state::record_message(sender.clone(), env.to.clone(), env.body);

    let target = env.to.clone();
    let target_room = env.from_room.clone();
    let reg_for_submit = registry.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = reg_for_submit.write_to_agent(target_room.as_deref(), &target, b"\r");
    });

    let _ = writeln!(writer, "ok");
}
