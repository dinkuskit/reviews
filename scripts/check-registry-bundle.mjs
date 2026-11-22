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
// Four public routes: two read-only GETs of what a shopper already sees (reviews-public-read-20261122),
// and the buyer's review page with its form, which need the secret from the request email.
// No network host, and one capability: handing the request email to the store's own sender
// (reviews-request-email-sender-20261122). Each one is added on purpose, here and in the manifest together.
const open = manifest.routes.filter(route => route.public).map(route => route.name).sort();
if (open.join() !== "list,rating,send,write") throw new Error(`the Reviews plugin's public routes are list, rating, send and write, found: ${open.join() || "none"}`);
// The courier's door is private and for the store's own code only (dinkuskit/courier docs/doors.md).
const door = manifest.routes.find(route => route.name === "courier/inbox");
if (!door || door.public || door.permission !== "plugins:manage") throw new Error("courier/inbox must be a private route with the plugins:manage permission");
if ((manifest.allowedHosts ?? []).length > 0 || (manifest.capabilities ?? []).join() !== "email:send") throw new Error("the Reviews plugin asks for no host and for the email:send capability only");
console.log([
  "registry_bundle=pass",
  `backend_bytes=${backend.byteLength}`,
  `headroom_bytes=${REGISTRY_FILE_LIMIT_BYTES - backend.byteLength}`,
  `backend_sha256=${createHash("sha256").update(backend).digest("hex")}`,
].join(" "));
