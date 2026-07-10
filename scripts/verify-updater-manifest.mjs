#!/usr/bin/env node

import fs from "node:fs";
import { validateUpdaterManifest } from "./release-utils.mjs";

const [manifestPath, expectedVersion, signaturePath] = process.argv.slice(2);

if (!manifestPath || !expectedVersion) {
  console.error("Usage: verify-updater-manifest.mjs <latest.json> <expected-version> [signature-file]");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Could not read updater manifest: ${error}`);
  process.exit(1);
}

let expectedSignature = null;
if (signaturePath) {
  try {
    expectedSignature = fs.readFileSync(signaturePath, "utf8").trim();
  } catch (error) {
    console.error(`Could not read updater signature: ${error}`);
    process.exit(1);
  }
}

const errors = validateUpdaterManifest(manifest, expectedVersion, expectedSignature);
if (errors.length > 0) {
  for (const error of errors) console.error(`updater check: ${error}`);
  process.exit(1);
}

console.log(`Updater manifest contains a signed macOS ARM package for ${expectedVersion}.`);
