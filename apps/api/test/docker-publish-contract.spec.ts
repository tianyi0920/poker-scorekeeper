import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const contractPath = resolve(repositoryRoot, 'scripts/release/docker-publish-contract.mjs');
const contract = await import(contractPath);
const commit = '0123456789abcdef0123456789abcdef01234567';

function imageIdentity(architecture: string, revision = commit) {
  return {
    os: 'linux',
    architecture,
    labels: { 'org.opencontainers.image.revision': revision }
  };
}

type ImageIdentity = ReturnType<typeof imageIdentity>;

describe('Docker publication contract', () => {
  it('derives fixed release metadata from a stable tag and full lowercase commit', () => {
    // Break caught: a fixed release loses its immutable full-commit tracking tag.
    expect(contract.deriveReleaseMetadata('v1.0.0', commit)).toEqual({
      version: '1.0.0',
      shaTag: `sha-${commit}`,
      deploymentId: commit
    });
  });

  it.each([
    ['v1.0.0-rc.1', commit],
    ['v1.0.0+build.1', commit],
    ['1.0.0', commit],
    ['main', commit],
    ['latest', commit],
    ['v1.0.0', commit.toUpperCase()],
    ['v1.0.0', commit.slice(0, -1)]
  ])('rejects mutable or invalid release input %s', (refName, fullCommit) => {
    // Break caught: a branch, prerelease, or non-canonical commit can publish a fixed tag.
    expect(() => contract.deriveReleaseMetadata(refName, fullCommit)).toThrow(
      /^(INVALID_RELEASE_TAG|INVALID_FULL_COMMIT)$/
    );
  });

  it('queries both immutable Docker Hub tag forms and treats 404 as absent', async () => {
    // Break caught: the preflight checks only the semver tag and can overwrite a full-commit tag on rerun.
    const fetchImpl = vi.fn(async () => ({ status: 404, redirected: false, type: 'basic' }));

    await expect(contract.assertDockerHubTagAbsent('tianyi920/poker-scorekeeper', '1.0.0', fetchImpl))
      .resolves.toBeUndefined();
    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper', `sha-${commit}`, fetchImpl
    )).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls).toEqual([
      [
        'https://hub.docker.com/v2/repositories/tianyi920/poker-scorekeeper/tags/1.0.0',
        { redirect: 'manual' }
      ],
      [
        `https://hub.docker.com/v2/repositories/tianyi920/poker-scorekeeper/tags/sha-${commit}`,
        { redirect: 'manual' }
      ]
    ]);
  });

  it.each(['latest', 'sha-short', `sha-${commit.toUpperCase()}`, 'v1.0.0'])(
    'rejects a non-canonical immutable tag %s', async (tag) => {
      const fetchImpl = vi.fn();
      await expect(contract.assertDockerHubTagAbsent(
        'tianyi920/poker-scorekeeper', tag, fetchImpl
      )).rejects.toThrow('REMOTE_TAG_STATUS_UNKNOWN');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('fails closed when the fixed Docker Hub tag already exists', async () => {
    // Break caught: a 200 response permits an immutable fixed tag to be overwritten.
    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper',
      '1.0.0',
      async () => ({ status: 200, redirected: false, type: 'basic' })
    )).rejects.toThrow('FIXED_TAG_ALREADY_EXISTS');
  });

  it.each([
    { status: 404, redirected: true, type: 'basic' },
    { status: 404, redirected: false, type: 'opaqueredirect' },
    { status: 302, redirected: false, type: 'basic' }
  ])('fails closed for Docker Hub redirect response %#', async (response) => {
    // Break caught: a redirected request ending in 404 is accepted as an absent immutable tag.
    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper',
      '1.0.0',
      async () => response
    )).rejects.toThrow('REMOTE_TAG_STATUS_UNKNOWN');
  });

  it.each([
    [async () => ({ status: 401 })],
    [async () => ({ status: 500 })],
    [async () => { throw new Error('network unavailable'); }],
    [async () => ({})]
  ])('fails closed when Docker Hub tag status is not known', async (fetchImpl) => {
    // Break caught: any unconfirmed remote state is mistaken for an absent fixed tag.
    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper',
      '1.0.0',
      fetchImpl
    )).rejects.toThrow('REMOTE_TAG_STATUS_UNKNOWN');
  });

  it('fails closed when a Docker Hub response cannot provide a valid status', async () => {
    // Break caught: a malformed response escapes as an unstable error instead of blocking publication.
    const invalidResponse = {
      get status() {
        throw new Error('unreadable status');
      }
    };

    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper',
      '1.0.0',
      async () => invalidResponse
    )).rejects.toThrow('REMOTE_TAG_STATUS_UNKNOWN');
  });

  it('accepts exactly one linux amd64 and one linux arm64 executable manifest', () => {
    // Break caught: a valid two-platform OCI index is rejected.
    expect(() => contract.assertManifestPlatforms({
      manifests: [
        { platform: { os: 'linux', architecture: 'amd64' } },
        { platform: { os: 'linux', architecture: 'arm64' } }
      ]
    }, ['linux/amd64', 'linux/arm64'])).not.toThrow();
  });

  it('accepts only a fully identified Buildx attestation beside the two executable platforms', () => {
    // Break caught: a legitimate Buildx attestation prevents validating the two executable platforms.
    expect(() => contract.assertManifestPlatforms({
      manifests: [
        { platform: { os: 'linux', architecture: 'amd64' } },
        { platform: { os: 'linux', architecture: 'arm64' } },
        {
          platform: { os: 'unknown', architecture: 'unknown' },
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': `sha256:${'a'.repeat(64)}`
          }
        }
      ]
    }, ['linux/amd64', 'linux/arm64'])).not.toThrow();
  });

  it.each([
    [{ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }],
    { manifests: [
      { platform: { os: 'linux', architecture: 'amd64' } },
      { platform: { os: 'linux', architecture: 'amd64' } },
      { platform: { os: 'linux', architecture: 'arm64' } }
    ] },
    { manifests: [
      { platform: { os: 'linux', architecture: 'amd64' } },
      { platform: { os: 'linux', architecture: 'arm64' } },
      { platform: { os: 'linux', architecture: 's390x' } }
    ] }
  ])('rejects a missing, duplicate, or extra executable platform', (rawManifest) => {
    // Break caught: a partial or expanded image index passes the immutable platform contract.
    expect(() => contract.assertManifestPlatforms(rawManifest, ['linux/amd64', 'linux/arm64']))
      .toThrow('MANIFEST_PLATFORMS_INVALID');
  });

  it.each([
    { platform: { os: 'unknown', architecture: 'unknown' } },
    {
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: {
        'vnd.docker.reference.type': 'not-an-attestation',
        'vnd.docker.reference.digest': `sha256:${'a'.repeat(64)}`
      }
    },
    {
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: {
        'vnd.docker.reference.type': 'attestation-manifest',
        'vnd.docker.reference.digest': 'sha256:not-a-digest'
      }
    }
  ])('rejects an unknown platform that is not a complete Buildx attestation', (unknownDescriptor) => {
    // Break caught: unclassified or malformed unknown descriptors hide extra unverified content.
    expect(() => contract.assertManifestPlatforms({
      manifests: [
        { platform: { os: 'linux', architecture: 'amd64' } },
        { platform: { os: 'linux', architecture: 'arm64' } },
        unknownDescriptor
      ]
    }, ['linux/amd64', 'linux/arm64'])).toThrow('MANIFEST_PLATFORMS_INVALID');
  });

  it('requires both architecture image revisions to equal the full release commit', () => {
    // Break caught: one platform image is built from a different source revision.
    expect(() => contract.assertImageIdentity([
      imageIdentity('amd64'),
      imageIdentity('arm64')
    ], commit)).not.toThrow();
  });

  it.each([
    [imageIdentity('amd64')],
    [imageIdentity('amd64'), imageIdentity('amd64')],
    [
      imageIdentity('amd64'),
      imageIdentity('arm64', 'fedcba9876543210fedcba9876543210fedcba98')
    ],
    [
      imageIdentity('amd64'),
      imageIdentity('arm64', commit.toUpperCase())
    ],
    [imageIdentity('amd64'), imageIdentity('arm64'), imageIdentity('s390x')]
  ])('rejects missing, duplicate, extra, or inconsistent platform image identities', (...labels: ImageIdentity[]) => {
    // Break caught: an incomplete or mismatched per-platform image identity passes promotion.
    expect(() => contract.assertImageIdentity(labels, commit)).toThrow('IMAGE_IDENTITY_MISMATCH');
  });

  it('prints only a stable code and exits one for invalid CLI release input', () => {
    // Break caught: CLI validation leaks a stack or input details to an Actions log.
    const result = spawnSync(process.execPath, [contractPath, 'metadata', 'main', commit], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('INVALID_RELEASE_TAG');
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Error:|at |https?:\/\//i);
  });

  it('rejects a CLI manifest request that tries to weaken the required platform set', async () => {
    // Break caught: a workflow caller can validate only one architecture through the CLI.
    const root = await mkdtemp(join(tmpdir(), 'docker-publish-contract-'));
    const manifestPath = join(root, 'manifest.json');
    try {
      await writeFile(manifestPath, JSON.stringify({
        manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }]
      }));
      const result = spawnSync(process.execPath, [
        contractPath, 'manifest', manifestPath, 'linux/amd64'
      ], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('INVALID_CLI_ARGUMENTS');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes hostile manifest and identity accessors to stable contract errors', () => {
    // Break caught: a proxy or accessor leaks arbitrary exception text from an exported validator.
    const hostile = new Proxy({}, { get() { throw new Error('hostile accessor'); } });

    expect(() => contract.assertManifestPlatforms(hostile, ['linux/amd64', 'linux/arm64']))
      .toThrow('MANIFEST_PLATFORMS_INVALID');
    expect(() => contract.assertImageIdentity(hostile, commit)).toThrow('IMAGE_IDENTITY_MISMATCH');
  });
});
