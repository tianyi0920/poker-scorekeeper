import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const FULL_COMMIT_TAG = /^sha-[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DOCKER_HUB_REPOSITORY = 'tianyi920/poker-scorekeeper';
const STABLE_ERROR_CODES = new Set([
  'INVALID_RELEASE_TAG',
  'INVALID_FULL_COMMIT',
  'FIXED_TAG_ALREADY_EXISTS',
  'REMOTE_TAG_STATUS_UNKNOWN',
  'MANIFEST_PLATFORMS_INVALID',
  'IMAGE_IDENTITY_MISMATCH',
  'INVALID_CLI_ARGUMENTS'
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isStableContractError(error) {
  return error instanceof Error && STABLE_ERROR_CODES.has(error.message);
}

function validVersion(version) {
  return typeof version === 'string' && VERSION.test(version);
}

function validImmutableTag(tag) {
  return validVersion(tag) || (typeof tag === 'string' && FULL_COMMIT_TAG.test(tag));
}

function parseManifest(rawManifest) {
  if (typeof rawManifest === 'string') {
    try {
      return JSON.parse(rawManifest);
    } catch {
      fail('MANIFEST_PLATFORMS_INVALID');
    }
  }
  return rawManifest;
}

function normalizeExpectedPlatforms(expectedPlatforms) {
  if (!Array.isArray(expectedPlatforms) || expectedPlatforms.length === 0) {
    fail('MANIFEST_PLATFORMS_INVALID');
  }
  const expected = new Set(expectedPlatforms);
  if (
    expected.size !== expectedPlatforms.length
    || [...expected].some((platform) => typeof platform !== 'string' || !/^linux\/[a-z0-9]+$/.test(platform))
  ) {
    fail('MANIFEST_PLATFORMS_INVALID');
  }
  return expected;
}

export function deriveReleaseMetadata(refName, fullCommit) {
  const match = typeof refName === 'string' ? RELEASE_TAG.exec(refName) : null;
  if (!match) fail('INVALID_RELEASE_TAG');
  if (typeof fullCommit !== 'string' || !FULL_COMMIT.test(fullCommit)) fail('INVALID_FULL_COMMIT');

  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    shaTag: `sha-${fullCommit}`,
    deploymentId: fullCommit
  };
}

export async function assertDockerHubTagAbsent(repository, tag, fetchImpl) {
  if (repository !== DOCKER_HUB_REPOSITORY || !validImmutableTag(tag) || typeof fetchImpl !== 'function') {
    fail('REMOTE_TAG_STATUS_UNKNOWN');
  }

  let response;
  try {
    response = await fetchImpl(
      `https://hub.docker.com/v2/repositories/${DOCKER_HUB_REPOSITORY}/tags/${tag}`,
      { redirect: 'manual' }
    );
  } catch {
    fail('REMOTE_TAG_STATUS_UNKNOWN');
  }

  let status;
  let redirected;
  let type;
  try {
    status = response?.status;
    redirected = response?.redirected;
    type = response?.type;
  } catch {
    fail('REMOTE_TAG_STATUS_UNKNOWN');
  }
  if (redirected !== false || !['basic', 'cors', 'default'].includes(type)) {
    fail('REMOTE_TAG_STATUS_UNKNOWN');
  }
  if (status === 404) return;
  if (status === 200) fail('FIXED_TAG_ALREADY_EXISTS');
  fail('REMOTE_TAG_STATUS_UNKNOWN');
}

export function assertManifestPlatforms(rawManifest, expectedPlatforms) {
  try {
    const manifest = parseManifest(rawManifest);
    const expected = normalizeExpectedPlatforms(expectedPlatforms);
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.manifests)) {
      fail('MANIFEST_PLATFORMS_INVALID');
    }

    const actual = new Set();
    for (const descriptor of manifest.manifests) {
      const platform = descriptor?.platform;
      if (!platform || typeof platform !== 'object') fail('MANIFEST_PLATFORMS_INVALID');
      const { os, architecture } = platform;
      if (os === 'unknown' && architecture === 'unknown') {
        const annotations = descriptor.annotations;
        if (
          !annotations
          || typeof annotations !== 'object'
          || annotations['vnd.docker.reference.type'] !== 'attestation-manifest'
          || typeof annotations['vnd.docker.reference.digest'] !== 'string'
          || !SHA256_DIGEST.test(annotations['vnd.docker.reference.digest'])
        ) {
          fail('MANIFEST_PLATFORMS_INVALID');
        }
        continue;
      }
      if (typeof os !== 'string' || typeof architecture !== 'string' || os === 'unknown' || architecture === 'unknown') {
        fail('MANIFEST_PLATFORMS_INVALID');
      }
      const identifier = `${os}/${architecture}`;
      if (!expected.has(identifier) || actual.has(identifier)) fail('MANIFEST_PLATFORMS_INVALID');
      actual.add(identifier);
    }

    if (actual.size !== expected.size || [...expected].some((platform) => !actual.has(platform))) {
      fail('MANIFEST_PLATFORMS_INVALID');
    }
  } catch (error) {
    if (isStableContractError(error)) throw error;
    fail('MANIFEST_PLATFORMS_INVALID');
  }
}

export function assertImageIdentity(identities, expectedCommit) {
  try {
    if (
      typeof expectedCommit !== 'string'
      || !FULL_COMMIT.test(expectedCommit)
      || !Array.isArray(identities)
      || identities.length !== 2
    ) {
      fail('IMAGE_IDENTITY_MISMATCH');
    }

    const expectedPlatforms = new Set(['linux/amd64', 'linux/arm64']);
    const actualPlatforms = new Set();
    for (const identity of identities) {
      if (!identity || typeof identity !== 'object') fail('IMAGE_IDENTITY_MISMATCH');
      const { os, architecture, labels } = identity;
      const platform = `${os}/${architecture}`;
      if (
        os !== 'linux'
        || !expectedPlatforms.has(platform)
        || actualPlatforms.has(platform)
        || !labels
        || typeof labels !== 'object'
        || labels['org.opencontainers.image.revision'] !== expectedCommit
      ) {
        fail('IMAGE_IDENTITY_MISMATCH');
      }
      actualPlatforms.add(platform);
    }
    if (actualPlatforms.size !== expectedPlatforms.size) fail('IMAGE_IDENTITY_MISMATCH');
  } catch (error) {
    if (isStableContractError(error)) throw error;
    fail('IMAGE_IDENTITY_MISMATCH');
  }
}

function stableErrorCode(error) {
  return isStableContractError(error)
    ? error.message
    : 'INVALID_CLI_ARGUMENTS';
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('INVALID_CLI_ARGUMENTS');
  }
}

async function main(args) {
  const [command, ...commandArgs] = args;
  if (command === 'metadata' && commandArgs.length === 2) {
    process.stdout.write(`${JSON.stringify(deriveReleaseMetadata(commandArgs[0], commandArgs[1]))}\n`);
    return;
  }
  if (command === 'tag-absent' && commandArgs.length === 2) {
    await assertDockerHubTagAbsent(commandArgs[0], commandArgs[1], globalThis.fetch);
    return;
  }
  if (command === 'manifest' && commandArgs.length === 1) {
    const rawManifest = await readFile(commandArgs[0], 'utf8').catch(() => fail('INVALID_CLI_ARGUMENTS'));
    assertManifestPlatforms(rawManifest, ['linux/amd64', 'linux/arm64']);
    return;
  }
  if (command === 'identity' && commandArgs.length === 2) {
    assertImageIdentity(await readJsonFile(commandArgs[0]), commandArgs[1]);
    return;
  }
  fail('INVALID_CLI_ARGUMENTS');
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${stableErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
