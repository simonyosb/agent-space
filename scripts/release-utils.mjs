import fs from "node:fs";
import path from "node:path";

const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function readReleaseVersions(repoRoot = process.cwd()) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const cargoToml = fs.readFileSync(
    path.join(repoRoot, "src-tauri", "Cargo.toml"),
    "utf8",
  );
  const cargoPackage = cargoToml.match(
    /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
  );

  if (!cargoPackage) {
    throw new Error("Could not read [package].version from src-tauri/Cargo.toml.");
  }

  return {
    packageJson: String(packageJson.version ?? ""),
    tauriConfig: String(tauriConfig.version ?? ""),
    cargoPackage: cargoPackage[1],
  };
}

export function validateReleaseVersions(versions, tag = null) {
  const errors = [];
  const entries = Object.entries(versions);
  const canonicalVersion = versions.tauriConfig;

  for (const [source, version] of entries) {
    if (!stableSemverPattern.test(version)) {
      errors.push(`${source} must use a stable semantic version: ${version || "<empty>"}`);
    }
  }

  const distinctVersions = new Set(entries.map(([, version]) => version));
  if (distinctVersions.size !== 1) {
    errors.push(
      `Release versions do not match: ${entries
        .map(([source, version]) => `${source}=${version || "<empty>"}`)
        .join(", ")}`,
    );
  }

  if (tag && tag !== `v${canonicalVersion}`) {
    errors.push(`Release tag ${tag} must exactly match v${canonicalVersion}.`);
  }

  return errors;
}

export function validateUpdaterManifest(manifest, expectedVersion, expectedSignature = null) {
  const errors = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Updater manifest must be a JSON object."];
  }

  if (manifest.version !== expectedVersion) {
    errors.push(
      `Updater version ${String(manifest.version ?? "<missing>")} does not match ${expectedVersion}.`,
    );
  }

  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    errors.push("Updater manifest is missing its platforms object.");
    return errors;
  }

  const macEntries = Object.entries(platforms).filter(([target]) =>
    target === "darwin-aarch64" || target.startsWith("darwin-aarch64-"),
  );

  if (macEntries.length === 0) {
    errors.push("Updater manifest has no darwin-aarch64 package.");
    return errors;
  }

  for (const [target, value] of macEntries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`Updater platform ${target} must be an object.`);
      continue;
    }

    const signature = typeof value.signature === "string" ? value.signature.trim() : "";
    const url = typeof value.url === "string" ? value.url : "";

    if (signature.length < 64) {
      errors.push(`Updater platform ${target} has no usable signature.`);
    }
    if (!url.startsWith("https://github.com/simonyos/agent-space/releases/download/")) {
      errors.push(`Updater platform ${target} points outside the AgentSpace release repository.`);
    } else if (!url.includes(`/releases/download/v${expectedVersion}/`)) {
      errors.push(`Updater platform ${target} does not point to release v${expectedVersion}.`);
    }
  }

  if (expectedSignature && !macEntries.some(([, value]) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.signature === "string" && value.signature.trim() === expectedSignature.trim()
  )) {
    errors.push("Updater manifest signature does not match the generated macOS ARM signature.");
  }

  return errors;
}
