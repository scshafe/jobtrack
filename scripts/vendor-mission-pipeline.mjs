#!/usr/bin/env node
// scripts/vendor-mission-pipeline.mjs — (re)vendor a Mission Pipeline release tree
// byte-for-byte, with the manifest lib/draft-runner/vendor-pin.js verifies.
//
//   node scripts/vendor-mission-pipeline.mjs --source <checkout> --commit <sha> \
//        --dest vendor/mission-pipeline --release 1.0.0 \
//        --manifest-version jobtrack-pinned-mission-pipeline.v1
//
// The tree is taken from `git archive <commit>` of the source checkout — never
// from a working copy or an installed node_modules — so the vendored bytes are
// exactly the published commit's `lib/`, `schemas/`, `package.json`, `LICENSE`
// and `README.md`. manifest.json pins every file's SHA-256 plus the source
// repository/release/commit/tree; the pin verifier fails closed on any drift.
//
// After running: update the matching PINS entry in lib/draft-runner/vendor-pin.js
// (release, commit, tree, packageVersion) and vendor/README.md. Node stdlib only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED_PATHS = ["lib", "schemas", "package.json", "LICENSE", "README.md"];

function parseArgs(argv) {
  const args = { repository: "scshafe/mission-pipeline" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[++index];
    if (token === "--source") args.source = value();
    else if (token === "--commit") args.commit = value();
    else if (token === "--dest") args.dest = value();
    else if (token === "--release") args.release = value();
    else if (token === "--manifest-version") args.manifestVersion = value();
    else if (token === "--repository") args.repository = value();
    else throw new Error(`unknown argument ${token}`);
  }
  for (const key of ["source", "commit", "dest", "release", "manifestVersion"]) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return args;
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
    else throw new Error(`refusing to vendor a non-regular entry: ${candidate}`);
  }
  return files;
}

export function buildManifest({ root, manifestVersion, repository, release, commit, tree, packageVersion }) {
  const files = {};
  for (const file of listFiles(root).sort()) {
    const rel = relative(root, file);
    if (rel === "manifest.json") continue;
    files[rel] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return { schemaVersion: manifestVersion, sourceRepository: repository, sourceRelease: release, sourceCommit: commit, sourceTree: tree, packageVersion, files };
}

if (process.argv[1] && process.argv[1].endsWith("vendor-mission-pipeline.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source);
  const git = (...gitArgs) => execFileSync("git", ["-C", source, ...gitArgs], { encoding: "utf8" }).trim();
  const commit = git("rev-parse", `${args.commit}^{commit}`);
  const tree = git("rev-parse", `${commit}^{tree}`);
  const staging = mkdtempSync(join(tmpdir(), "vendor-mission-pipeline-"));
  try {
    const archive = execFileSync("git", ["-C", source, "archive", "--format=tar", commit, ...VENDORED_PATHS]);
    writeFileSync(join(staging, "tree.tar"), archive);
    mkdirSync(join(staging, "tree"));
    execFileSync("tar", ["-xf", join(staging, "tree.tar"), "-C", join(staging, "tree")]);
    const packageJson = JSON.parse(readFileSync(join(staging, "tree", "package.json"), "utf8"));
    const dest = resolve(ROOT, args.dest);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(staging, "tree"), dest, { recursive: true });
    const manifest = buildManifest({
      root: dest,
      manifestVersion: args.manifestVersion,
      repository: args.repository,
      release: args.release,
      commit,
      tree,
      packageVersion: packageJson.version
    });
    writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const count = Object.keys(manifest.files).length;
    console.log(`vendored ${packageJson.name}@${packageJson.version} (${count} files) from ${commit.slice(0, 12)} tree ${tree.slice(0, 12)} → ${relative(ROOT, dest)}`);
    console.log(`PINS entry: release ${args.release} · commit ${commit} · tree ${tree} · packageVersion ${packageJson.version}`);
    statSync(join(dest, "lib", "index.js"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
