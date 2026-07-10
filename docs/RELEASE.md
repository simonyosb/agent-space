# Releasing AgentSpace

AgentSpace releases are built from existing version tags. The release workflow
produces a signed and notarized macOS Apple Silicon app, a DMG, and the signed
Tauri updater artifacts used by installed copies of AgentSpace.

The workflow creates a draft GitHub release. Publish it only after every
verification step passes.

## Required accounts

- Write access to `simonyos/agent-space`.
- An active Apple Developer Program membership.
- A `Developer ID Application` certificate exported from Keychain Access as a
  password-protected `.p12` file.
- An Apple app-specific password for notarization.

Apple signing and Tauri updater signing are separate. Apple signing lets macOS
Gatekeeper trust the app. The Tauri key lets an installed AgentSpace verify that
an update was produced by this project.

Local builds use an ad-hoc macOS signature so Apple Silicon can verify bundle
integrity. `APPLE_SIGNING_IDENTITY` overrides that fallback in CI; only CI release
artifacts receive the Developer ID signature and notarization required for public
distribution.

## Tauri updater key

The updater public key is committed in `src-tauri/tauri.conf.json`. The matching
private key is stored outside the repository at:

```text
~/.agent-space/release/agent-space.key
```

Restrict local access and add the private key to GitHub Actions:

```bash
chmod 600 ~/.agent-space/release/agent-space.key
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.agent-space/release/agent-space.key
```

The current key does not have a password, so
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be absent. If the key is rotated to a
password-protected key, set that secret too.

Back up the private key somewhere encrypted. If it is lost, already-installed
apps cannot trust releases signed with a replacement key. Rotate it only before
the first public release or as a deliberate migration.

## Apple release secrets

Add these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `KEYCHAIN_PASSWORD` | A random password used only for the temporary CI keychain |

Encode and upload the certificate without printing it:

```bash
openssl base64 -A -in /path/to/DeveloperIDApplication.p12 | gh secret set APPLE_CERTIFICATE
```

Run `gh secret set <NAME>` for the remaining values so the CLI prompts without
putting secrets in shell history. The workflow fails before building and names
any missing secret.

## Prepare a release

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Run the local release checks:

```bash
bun run check:release
bun run test:release
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

3. Merge the version change to `main`.
4. Create and push an annotated tag from that exact commit:

```bash
git tag -a v0.1.0 -m "AgentSpace v0.1.0"
git push origin v0.1.0
```

The tag must exactly match the application version. A manual workflow dispatch
only reruns an existing tag; it never creates a release from an arbitrary branch.
Prerelease versions are rejected until AgentSpace has a separate prerelease update
channel, preventing beta builds from becoming the global `latest` release.

## What CI verifies

The release job will stop if any of these checks fail:

- The tag and all three version fields match.
- Every required updater and Apple secret exists.
- A Developer ID Application identity can be imported.
- The app, `fleet-msg`, and `fleet-mcp` have valid code signatures.
- Gatekeeper accepts the app and its Apple notarization ticket is stapled.
- The outer DMG is separately notarized, stapled, and replaces the preliminary
  draft asset produced during the Tauri build.
- The updater archive and signature exist.
- `latest.json` contains the expected version and a signed `darwin-aarch64`
  package hosted by `simonyos/agent-space`.

It also uploads workflow artifacts so a maintainer can inspect the exact output
even before publishing the draft GitHub release.

## Publish and smoke test

1. Download the draft DMG on a different Apple Silicon Mac or a clean macOS user
   account.
2. Install and launch AgentSpace from the DMG. There should be no Gatekeeper
   workaround or Privacy & Security override.
3. Create a disposable workspace, start one agent, send input, quit the app, and
   confirm the workspace and session return after relaunch.
4. Publish the draft release.

Production apps check this endpoint after startup:

```text
https://github.com/simonyos/agent-space/releases/latest/download/latest.json
```

When a newer signed version exists, AgentSpace shows a non-blocking notice. The
user chooses when to download and restart. Failed downloads leave the current app
untouched and can be retried.

## Emergency response

- Bad draft: delete the draft and rerun the workflow for the same existing tag.
- Bad published release: unpublish it immediately. Fix the app, bump the version,
  and issue a new tag; do not replace updater assets under an existing version.
- Lost updater private key: stop releases and plan a signed key migration before
  changing the committed public key.
- Revoked Apple certificate: issue a new Developer ID Application certificate,
  replace the Apple secrets, and ship a new version. Do not rotate the Tauri
  updater key at the same time unless necessary.
