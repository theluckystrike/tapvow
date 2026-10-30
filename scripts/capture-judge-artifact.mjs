#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_SOURCE_PATH = "packages/spendmandate/src/dashboard.html.ts";
export const EXPECTED_PACKAGE_FILES = ["LICENSE", "README.md", "dist"];
export const EXPECTED_MEMBERS = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli.js",
  "package/package.json",
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} exited ${result.status}: ${detail}`);
  }
  return result.stdout;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireRegularFile(path) {
  if (!existsSync(path)) {
    fail(`missing required file: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    fail(`symbolic link not allowed: ${path}`);
  }
  if (!stat.isFile()) {
    fail(`not a regular file: ${path}`);
  }
  if (stat.size === 0) {
    fail(`empty required file: ${path}`);
  }
}

export function validatePackage(packageDir) {
  for (const relative of ["package.json", "LICENSE", "README.md", "dist/cli.js"]) {
    requireRegularFile(join(packageDir, relative));
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    fail(`invalid package.json: ${error.message}`);
  }

  if (manifest.name !== "tapvow") {
    fail(`unexpected package name: ${String(manifest.name)}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    fail("package.json version is missing");
  }

  const files = Array.isArray(manifest.files) ? [...manifest.files].sort() : [];
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_PACKAGE_FILES)) {
    fail(`unexpected package files allowlist: ${JSON.stringify(manifest.files)}`);
  }

  return manifest;
}

export function parseTarMembers(namesOutput, verboseOutput) {
  const names = namesOutput.split(/\r?\n/).filter(Boolean);
  const lines = verboseOutput.split(/\r?\n/).filter(Boolean);
  if (names.length === 0) {
    fail("tarball has no members");
  }
  if (names.length !== lines.length) {
    fail(`tar name/list count mismatch: ${names.length} != ${lines.length}`);
  }

  return names.map((name, index) => {
    const type = lines[index][0];
    if (type !== "-") {
      fail(`non-regular tar member rejected: ${name} (type ${JSON.stringify(type)})`);
    }
    return { name, type: "file" };
  });
}

export function assertAllowedMembers(members, expected = EXPECTED_MEMBERS) {
  const actualNames = members.map((member) => member.name).sort();
  const expectedNames = [...expected].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(
      `unexpected tar members: actual ${JSON.stringify(actualNames)} expected ${JSON.stringify(expectedNames)}`,
    );
  }
  return actualNames;
}

export function inspectTarball(tarballPath) {
  const names = run("tar", ["-tzf", tarballPath]);
  const verbose = run("tar", ["-tvzf", tarballPath]);
  const members = parseTarMembers(names, verbose);
  assertAllowedMembers(members);
  return members;
}

function git(repoRoot, args) {
  return run("git", args, { cwd: repoRoot }).trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

export function main(repoRootOverride) {
  const repoRoot = repoRootOverride
    ? resolve(repoRootOverride)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageDir = join(repoRoot, "packages/spendmandate");
  const sourcePath = join(repoRoot, EXPECTED_SOURCE_PATH);

  requireRegularFile(sourcePath);
  const sourceSha256 = sha256File(sourcePath);

  const manifest = validatePackage(packageDir);
  const distCliPath = join(packageDir, "dist/cli.js");
  const distCliSha256 = sha256File(distCliPath);

  const checkoutHeadSha = git(repoRoot, ["rev-parse", "HEAD"]);
  const checkoutHeadSubject = git(repoRoot, ["show", "-s", "--format=%s", "HEAD"]);
  const githubSha = optionalEnv("GITHUB_SHA");
  const eventName = optionalEnv("GITHUB_EVENT_NAME");
  const prHeadSha = optionalEnv("GITHUB_PR_HEAD_SHA");
  const compiledSourceCommit = checkoutHeadSha;

  const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
  const artifactDir = mkdtempSync(join(runnerTemp, "tapvow-judge-"));
  if (readdirSync(artifactDir).length !== 0) {
    fail(`temporary artifact directory is not empty: ${artifactDir}`);
  }

  run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", artifactDir],
    { cwd: packageDir },
  );

  const packedEntries = readdirSync(artifactDir);
  const tarballs = packedEntries.filter((name) => name.endsWith(".tgz"));
  const expectedTarballName = `${manifest.name}-${manifest.version}.tgz`;
  if (packedEntries.length !== 1 || tarballs.length !== 1) {
    fail(`expected one packed tarball, found: ${JSON.stringify(packedEntries)}`);
  }
  if (tarballs[0] !== expectedTarballName) {
    fail(`unexpected tarball name: ${tarballs[0]} expected ${expectedTarballName}`);
  }

  const tarballPath = join(artifactDir, tarballs[0]);
  const tarballStat = statSync(tarballPath);
  if (!tarballStat.isFile() || tarballStat.size === 0) {
    fail(`packed tarball is missing or empty: ${tarballPath}`);
  }
  const tarballSha256 = sha256File(tarballPath);
  const members = inspectTarball(tarballPath);

  const checksumName = `${tarballs[0]}.sha256`;
  writeFileSync(join(artifactDir, checksumName), `${tarballSha256}  ${tarballs[0]}\n`);

  const provenance = {
    schema: "tapvow.judge-artifact.provenance/v1",
    generatedAt: new Date().toISOString(),
    repository: optionalEnv("GITHUB_REPOSITORY"),
    workflow: {
      ref: optionalEnv("GITHUB_WORKFLOW_REF"),
      runId: optionalEnv("GITHUB_RUN_ID"),
      runAttempt: optionalEnv("GITHUB_RUN_ATTEMPT"),
      eventName,
      refName: optionalEnv("GITHUB_REF"),
      serverUrl: optionalEnv("GITHUB_SERVER_URL"),
    },
    git: {
      checkoutHeadSha,
      checkoutHeadSubject,
      githubSha,
      githubShaMatchesCheckoutHead: githubSha === null ? null : githubSha === checkoutHeadSha,
      compiledSourceCommit,
      pullRequest:
        eventName === "pull_request"
          ? {
              headSha: prHeadSha,
              headRef: optionalEnv("GITHUB_PR_HEAD_REF"),
              baseSha: optionalEnv("GITHUB_PR_BASE_SHA"),
              baseRef: optionalEnv("GITHUB_PR_BASE_REF"),
            }
          : null,
    },
    source: {
      path: EXPECTED_SOURCE_PATH,
      sha256: sourceSha256,
      commit: compiledSourceCommit,
      distCliPath: "packages/spendmandate/dist/cli.js",
      distCliSha256,
    },
    package: {
      name: manifest.name,
      version: manifest.version,
      filesAllowlist: manifest.files,
      tarball: {
        filename: tarballs[0],
        bytes: tarballStat.size,
        sha256: tarballSha256,
      },
      members,
    },
    build: {
      nodeVersion: process.version,
      npmVersion: run("npm", ["--version"]).trim(),
      platform: process.platform,
      arch: process.arch,
      runnerOs: optionalEnv("RUNNER_OS"),
      runnerArch: optionalEnv("RUNNER_ARCH"),
      packCommand: "npm pack --ignore-scripts --pack-destination <unique-empty-temp-dir>",
      rebuiltByPack: false,
    },
    notes: [
      "The tarball contains the already-built dist/cli.js produced by the preceding full CI build; npm pack --ignore-scripts does not rebuild it.",
      "compiledSourceCommit is the exact checked-out commit that was built, including a synthetic merge commit on pull_request runs; pull request head and base are separate metadata.",
      "This provenance records exact inputs and outputs for this run; it does not claim byte-for-byte reproducibility across runs.",
    ],
  };

  const provenanceName = "provenance.json";
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  writeFileSync(join(artifactDir, provenanceName), provenanceText);

  const finalEntries = readdirSync(artifactDir).sort();
  const expectedEntries = [provenanceName, checksumName, tarballs[0]].sort();
  if (JSON.stringify(finalEntries) !== JSON.stringify(expectedEntries)) {
    fail(`unexpected artifact directory contents: ${JSON.stringify(finalEntries)}`);
  }

  const summary = {
    artifactDir,
    tarball: tarballs[0],
    tarballSha256,
    checksum: checksumName,
    provenance: provenanceName,
    provenanceSha256: sha256File(join(artifactDir, provenanceName)),
    sourceSha256,
    compiledSourceCommit,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `dir=${artifactDir}\n`);
  }

  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
