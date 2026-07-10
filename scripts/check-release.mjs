#!/usr/bin/env node

import { readReleaseVersions, validateReleaseVersions } from "./release-utils.mjs";

const args = process.argv.slice(2);
let tag = null;

for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--tag" || !args[index + 1]) {
    console.error(`Unknown or incomplete argument: ${args[index]}`);
    process.exit(2);
  }
  tag = args[index + 1];
  index += 1;
}

const versions = readReleaseVersions();
const errors = validateReleaseVersions(versions, tag);

if (errors.length > 0) {
  for (const error of errors) console.error(`release check: ${error}`);
  process.exit(1);
}

console.log(`Release metadata is consistent at ${versions.tauriConfig}${tag ? ` (${tag})` : ""}.`);
