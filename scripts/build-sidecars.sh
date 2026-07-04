#!/usr/bin/env bash
set -euo pipefail

target=""
profile="release"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    --debug)
      profile="debug"
      shift
      ;;
    --release)
      profile="release"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$target" ]]; then
  target="$(rustc --print host-tuple 2>/dev/null || rustc -Vv | awk '/host:/ {print $2}')"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri_dir="$repo_root/src-tauri"
out_dir="$tauri_dir/binaries"
mkdir -p "$out_dir"

# Tauri validates externalBin paths during the package build script. The helper
# bins are built from this same Cargo package, so seed executable placeholders
# first, then overwrite them with the real compiled binaries below.
touch "$out_dir/fleet-msg-$target" "$out_dir/fleet-mcp-$target"
chmod +x "$out_dir/fleet-msg-$target" "$out_dir/fleet-mcp-$target"

cargo_args=(build --manifest-path "$tauri_dir/Cargo.toml" --bin fleet-msg --bin fleet-mcp --target "$target")
if [[ "$profile" == "release" ]]; then
  cargo_args+=(--release)
fi

cargo "${cargo_args[@]}"

target_dir="$tauri_dir/target/$target/$profile"
cp "$target_dir/fleet-msg" "$out_dir/fleet-msg-$target"
cp "$target_dir/fleet-mcp" "$out_dir/fleet-mcp-$target"
chmod +x "$out_dir/fleet-msg-$target" "$out_dir/fleet-mcp-$target"

echo "Built AgentSpace sidecars for $target"
