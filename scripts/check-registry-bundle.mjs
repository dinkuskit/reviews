import { bundlePlugin } from "@emdash-cms/plugin-cli";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

// Runs the official Registry packaging on this repository's root plugin, so a
// backend over the 128 KiB per-file cap (RFC 0001) fails the build instead of a
// later install. bundlePlugin enforces the limit; this reports the headroom.
const REGISTRY_FILE_LIMIT_BYTES = 128 * 1024;
const directory = resolve(".tmp/registry-bundle");
await rm(directory, { recursive: true, force: true });
const extracted = resolve(directory, "extracted");
await mkdir(extracted, { recursive: true });
const artifact = await bundlePlugin({ dir: resolve("."), outDir: resolve(directory, "build") });
execFileSync("tar", ["-xf", artifact.tarballPath, "-C", extracted]);
const backend = await readFile(resolve(extracted, "backend.js"));
const manifest = JSON.parse(await readFile(resolve(extracted, "manifest.json"), "utf8"));
if (manifest.id !== "dinkus-reviews") throw new Error(`unexpected plugin id ${manifest.id}`);
// The scaffold has no public route, no network host and no capability. Each one is added on purpose, here and in the manifest together.
if (manifest.routes.some(route => route.public)) throw new Error("the Reviews plugin has no public route yet");
if ((manifest.allowedHosts ?? []).length > 0 || (manifest.capabilities ?? []).length > 0) throw new Error("the Reviews plugin asks for no host or capability yet");
console.log([
  "registry_bundle=pass",
  `backend_bytes=${backend.byteLength}`,
  `headroom_bytes=${REGISTRY_FILE_LIMIT_BYTES - backend.byteLength}`,
  `backend_sha256=${createHash("sha256").update(backend).digest("hex")}`,
].join(" "));
