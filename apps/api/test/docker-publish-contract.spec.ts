import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const contractPath = resolve(repositoryRoot, 'scripts/release/docker-publish-contract.mjs');
const contract = await import(contractPath);
const commit = '0123456789abcdef0123456789abcdef01234567';

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

  it('queries only the fixed Docker Hub tag and treats 404 as absent', async () => {
    // Break caught: the fixed-tag preflight probes a different resource or rejects a confirmed absence.
    const fetchImpl = vi.fn(async () => ({ status: 404 }));

    await expect(contract.assertDockerHubTagAbsent('tianyi920/poker-scorekeeper', '1.0.0', fetchImpl))
      .resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hub.docker.com/v2/repositories/tianyi920/poker-scorekeeper/tags/1.0.0'
    );
  });

  it('fails closed when the fixed Docker Hub tag already exists', async () => {
    // Break caught: a 200 response permits an immutable fixed tag to be overwritten.
    await expect(contract.assertDockerHubTagAbsent(
      'tianyi920/poker-scorekeeper',
      '1.0.0',
      async () => ({ status: 200 })
    )).rejects.toThrow('FIXED_TAG_ALREADY_EXISTS');
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

  it('requires both architecture image revisions to equal the full release commit', () => {
    // Break caught: one platform image is built from a different source revision.
    expect(() => contract.assertImageIdentity([
      { 'org.opencontainers.image.revision': commit },
      { 'org.opencontainers.image.revision': commit }
    ], commit)).not.toThrow();
  });

  it.each([
    [{ 'org.opencontainers.image.revision': commit }],
    [
      { 'org.opencontainers.image.revision': commit },
      { 'org.opencontainers.image.revision': 'fedcba9876543210fedcba9876543210fedcba98' }
    ],
    [
      { 'org.opencontainers.image.revision': commit },
      { 'org.opencontainers.image.revision': commit.toUpperCase() }
    ]
  ])('rejects missing or inconsistent architecture revision labels', (labels) => {
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
});
