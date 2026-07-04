use crate::runtime_profile;
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    buffer: Arc<Mutex<Vec<u8>>>,
    exited: Arc<AtomicBool>,
}

#[derive(Default, Clone)]
pub struct PtyRegistry {
    ptys: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

impl PtyRegistry {
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let map = self.ptys.lock();
        let handle = map.get(id).ok_or_else(|| format!("pty {} not found", id))?;
        if handle.exited.load(Ordering::Relaxed) {
            return Err(format!("pty {} has exited", id));
        }
        let mut w = handle.writer.lock();
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn agent_ids(&self) -> Vec<String> {
        self.ptys.lock().keys().cloned().collect()
    }

    pub fn read_buffer(&self, id: &str) -> Result<Vec<u8>, String> {
        let map = self.ptys.lock();
        let handle = map.get(id).ok_or_else(|| format!("pty {} not found", id))?;
        let buffer = handle.buffer.clone();
        drop(map);
        let bytes = buffer.lock().clone();
        Ok(bytes)
    }

    pub fn kill(&self, id: &str) {
        if let Some(handle) = self.ptys.lock().remove(id) {
            let _ = handle.child.lock().kill();
        }
    }

    pub fn write_to_agent(
        &self,
        room_id: Option<&str>,
        id: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let scoped_id = room_id
            .filter(|room| !room.is_empty() && !id.contains(':'))
            .map(|room| format!("{}:{}", room, id));
        if let Some(scoped_id) = scoped_id.as_deref() {
            if self.ptys.lock().contains_key(scoped_id) {
                return self.write(scoped_id, data);
            }
        }
        self.write(id, data)
    }
}

#[derive(Serialize, Clone)]
struct PtyDataEvent {
    id: String,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct PtyExitEvent {
    id: String,
    code: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPtyResult {
    id: String,
    state: String,
    exited: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyStatus {
    id: String,
    exists: bool,
    exited: bool,
    buffer_len: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_scope: Option<String>,
    #[serde(default)]
    pub restart: bool,
    pub cwd: Option<String>,
    pub cmd: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

fn fleet_msg_dir() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_string_lossy().to_string()))
}

fn command_path(base_path: String) -> String {
    let mut paths: Vec<String> = Vec::new();
    if let Some(dir) = fleet_msg_dir() {
        paths.push(dir);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.join(".local/bin").to_string_lossy().to_string());
        paths.push(home.join("bin").to_string_lossy().to_string());
        paths.push(home.join(".cargo/bin").to_string_lossy().to_string());
    }
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .iter()
        .map(|path| path.to_string()),
    );
    paths.extend(
        base_path
            .split(':')
            .filter(|path| !path.is_empty())
            .map(|path| path.to_string()),
    );

    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.contains(&path) {
            deduped.push(path);
        }
    }
    deduped.join(":")
}

fn user_codex_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex"))
}

fn safe_agent_dir_name(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(unix)]
fn link_or_copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::os::unix::fs::symlink(source, dest)
        .or_else(|_| fs::copy(source, dest).map(|_| ()))
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn link_or_copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(source, dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn isolated_codex_home(agent_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(root) = runtime_profile::config_dir() else {
        return Ok(None);
    };
    let home = root
        .join("agent-homes")
        .join(safe_agent_dir_name(agent_id))
        .join("codex");
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;

    if let Some(source_home) = user_codex_home() {
        for file_name in ["auth.json", "config.toml", "AGENTS.md", "installation_id"] {
            let source = source_home.join(file_name);
            if source.exists() {
                let _ = link_or_copy_file(&source, &home.join(file_name));
            }
        }
    }

    Ok(Some(home))
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    args: SpawnArgs,
) -> Result<SpawnPtyResult, String> {
    let SpawnArgs {
        id,
        agent_id,
        session_scope,
        restart,
        cwd,
        cmd,
        args: cmd_args,
        cols,
        rows,
    } = args;
    let cols = cols.clamp(2, 500);
    let rows = rows.clamp(1, 500);
    let agent_env_id = agent_id.unwrap_or_else(|| id.clone());
    let existing_exited = registry
        .ptys
        .lock()
        .get(&id)
        .map(|handle| handle.exited.load(Ordering::Relaxed));
    let spawn_state = match existing_exited {
        Some(false) if !restart => {
            if let Some(handle) = registry.ptys.lock().get(&id) {
                let _ = handle.master.lock().resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            return Ok(SpawnPtyResult {
                id,
                state: "attached".to_string(),
                exited: false,
            });
        }
        Some(true) if !restart => {
            return Ok(SpawnPtyResult {
                id,
                state: "exited".to_string(),
                exited: true,
            });
        }
        Some(_) => {
            registry.kill(&id);
            "restarted"
        }
        None => "spawned",
    };

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd_builder = CommandBuilder::new(&cmd);
    for a in &cmd_args {
        cmd_builder.arg(a);
    }
    if let Some(d) = cwd {
        cmd_builder.cwd(d);
    }

    let mut path_value: Option<String> = None;
    for (k, v) in std::env::vars() {
        if k == "PATH" {
            path_value = Some(v.clone());
            continue;
        }
        cmd_builder.env(k, v);
    }
    cmd_builder.env("PATH", command_path(path_value.unwrap_or_default()));
    cmd_builder.env("TERM", "xterm-256color");
    cmd_builder.env("FLEET_AGENT_ID", &agent_env_id);
    cmd_builder.env("FLEET_PROFILE", runtime_profile::profile_name());
    if let Some(room_id) = session_scope
        .as_deref()
        .and_then(|scope| scope.split_once(':').map(|(room, _)| room))
    {
        cmd_builder.env("FLEET_ROOM_ID", room_id);
    }
    cmd_builder.env("FLEET_PTY_ID", &id);
    cmd_builder.env("FLEET_SOCKET", runtime_profile::socket_path());
    if cmd == "codex" {
        let codex_scope = session_scope.as_deref().unwrap_or(&agent_env_id);
        if let Some(codex_home) = isolated_codex_home(codex_scope)? {
            cmd_builder.env("CODEX_HOME", codex_home.to_string_lossy().to_string());
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd_builder)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let output_buffer = Arc::new(Mutex::new(Vec::new()));
    let exited = Arc::new(AtomicBool::new(false));

    registry.ptys.lock().insert(
        id.clone(),
        PtyHandle {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
            buffer: output_buffer.clone(),
            exited: exited.clone(),
        },
    );

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    {
                        let mut buffer = output_buffer.lock();
                        buffer.extend_from_slice(&buf[..n]);
                        const MAX_BUFFER_BYTES: usize = 1024 * 1024;
                        if buffer.len() > MAX_BUFFER_BYTES {
                            let drain_to = buffer.len() - MAX_BUFFER_BYTES;
                            buffer.drain(..drain_to);
                        }
                    }
                    let _ = app_for_thread.emit(
                        &format!("pty:data:{}", id_for_thread),
                        PtyDataEvent {
                            id: id_for_thread.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        exited.store(true, Ordering::Relaxed);
        let _ = app_for_thread.emit(
            &format!("pty:exit:{}", id_for_thread),
            PtyExitEvent {
                id: id_for_thread.clone(),
                code: None,
            },
        );
    });

    Ok(SpawnPtyResult {
        id,
        state: spawn_state.to_string(),
        exited: false,
    })
}

#[tauri::command]
pub fn read_pty_buffer(registry: State<'_, PtyRegistry>, id: String) -> Result<Vec<u8>, String> {
    registry.read_buffer(&id)
}

#[tauri::command]
pub fn get_pty_status(registry: State<'_, PtyRegistry>, id: String) -> Result<PtyStatus, String> {
    let map = registry.ptys.lock();
    let Some(handle) = map.get(&id) else {
        return Ok(PtyStatus {
            id,
            exists: false,
            exited: false,
            buffer_len: 0,
        });
    };
    let exited = handle.exited.load(Ordering::Relaxed);
    let buffer_len = handle.buffer.lock().len();
    Ok(PtyStatus {
        id,
        exists: true,
        exited,
        buffer_len,
    })
}

#[tauri::command]
pub fn list_pty_statuses(registry: State<'_, PtyRegistry>) -> Result<Vec<PtyStatus>, String> {
    let map = registry.ptys.lock();
    Ok(map
        .iter()
        .map(|(id, handle)| PtyStatus {
            id: id.clone(),
            exists: true,
            exited: handle.exited.load(Ordering::Relaxed),
            buffer_len: handle.buffer.lock().len(),
        })
        .collect())
}

#[tauri::command]
pub fn write_pty(
    registry: State<'_, PtyRegistry>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    registry.write(&id, &data)
}

#[tauri::command]
pub fn resize_pty(
    registry: State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = registry.ptys.lock();
    let handle = map
        .get(&id)
        .ok_or_else(|| format!("pty {} not found", id))?;
    if handle.exited.load(Ordering::Relaxed) {
        return Ok(());
    }
    handle
        .master
        .lock()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn kill_pty(registry: State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    registry.kill(&id);
    Ok(())
}
