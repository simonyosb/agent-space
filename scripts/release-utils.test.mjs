import assert from "node:assert/strict";
import test from "node:test";

import {
  validateReleaseVersions,
  validateUpdaterManifest,
} from "./release-utils.mjs";

const versions = {
  packageJson: "1.2.3",
  tauriConfig: "1.2.3",
  cargoPackage: "1.2.3",
};

test("accepts matching release versions and tag", () => {
  assert.deepEqual(validateReleaseVersions(versions, "v1.2.3"), []);
});

test("rejects a mismatched version or tag", () => {
  assert.equal(
    validateReleaseVersions({ ...versions, cargoPackage: "1.2.2" }, "v1.2.4").length,
    2,
  );
});

test("rejects prerelease versions until a separate update channel exists", () => {
  const prerelease = {
    packageJson: "1.2.3-beta.1",
    tauriConfig: "1.2.3-beta.1",
    cargoPackage: "1.2.3-beta.1",
  };

  assert.equal(validateReleaseVersions(prerelease, "v1.2.3-beta.1").length, 3);
});

test("accepts a signed AgentSpace macOS ARM updater package", () => {
  const signature = "a".repeat(64);
  const manifest = {
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": {
        signature,
        url: "https://github.com/simonyos/agent-space/releases/download/v1.2.3/AgentSpace.app.tar.gz",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest, "1.2.3", signature), []);
});

test("rejects an unsigned or foreign updater package", () => {
  const manifest = {
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": {
        signature: "",
        url: "https://example.com/AgentSpace.app.tar.gz",
      },
    },
  };

  assert.equal(validateUpdaterManifest(manifest, "1.2.3").length, 2);
});

test("rejects a manifest whose signature does not match the built updater", () => {
  const manifest = {
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": {
        signature: "a".repeat(64),
        url: "https://github.com/simonyos/agent-space/releases/download/v1.2.3/AgentSpace.app.tar.gz",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest, "1.2.3", "b".repeat(64)), [
    "Updater manifest signature does not match the generated macOS ARM signature.",
  ]);
});

test("rejects a manifest that points at a different release tag", () => {
  const manifest = {
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": {
        signature: "a".repeat(64),
        url: "https://github.com/simonyos/agent-space/releases/download/v1.2.2/AgentSpace.app.tar.gz",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest, "1.2.3"), [
    "Updater platform darwin-aarch64 does not point to release v1.2.3.",
  ]);
});
