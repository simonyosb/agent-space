# Releasing AgentSpace

AgentSpace releases are built by GitHub Actions from version tags.

## One-time updater secret

The updater public key is committed in `src-tauri/tauri.conf.json`.
The matching private key was generated outside the repo at:

```bash
~/.agent-space/release/agent-space.key
```

Add the private key to the GitHub repository secrets:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.agent-space/release/agent-space.key
```

This is already configured on `simonyos/agent-space`; use the command above for
new forks or if the key is rotated.

This key was generated without a password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
can stay empty. If the key is regenerated with a password later, add that password
as the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret.

Keep the private key backed up. Losing it means future releases cannot be trusted
by already-installed apps.

## Publish a macOS Apple Silicon release

1. Update `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
   to the same version.
2. Commit the version bump.
3. Tag the commit:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow builds `aarch64-apple-darwin` on macOS, uploads the `.app`,
`.dmg`, updater signatures, and `latest.json`, then creates a draft GitHub release.

Review the draft release, then publish it. Installed production apps check:

```text
https://github.com/simonyos/agent-space/releases/latest/download/latest.json
```

When a newer signed release exists, AgentSpace prompts to install and relaunch.
