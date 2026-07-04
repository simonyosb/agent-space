use std::path::PathBuf;

pub fn is_dev_profile() -> bool {
    cfg!(debug_assertions)
}

pub fn profile_name() -> &'static str {
    if is_dev_profile() {
        "dev"
    } else {
        "production"
    }
}

pub fn config_dir_name() -> &'static str {
    if is_dev_profile() {
        ".agent-space-dev"
    } else {
        ".agent-space"
    }
}

pub fn legacy_config_dir_name() -> &'static str {
    if is_dev_profile() {
        ".claude-fleet-dev"
    } else {
        ".claude-fleet"
    }
}

pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(config_dir_name()))
}

pub fn legacy_config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(legacy_config_dir_name()))
}

pub fn socket_path() -> &'static str {
    if is_dev_profile() {
        "/tmp/agent-space-dev.sock"
    } else {
        "/tmp/agent-space.sock"
    }
}
