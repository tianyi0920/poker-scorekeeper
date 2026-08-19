import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const helperPath = resolve(repositoryRoot, 'scripts/release/release-helpers.ps1');

function powershell(script: string, environment?: NodeJS.ProcessEnv) {
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: 'utf8'
  });
}

windowsOnly('Task18 release PowerShell helpers', () => {
  it('creates the credential file inside an already protected directory', async () => {
    // Break caught: credentials are visible under inherited permissions between WriteAllLines and chmod/ACL.
    const root = await mkdtemp(join(tmpdir(), 'task18-private-env-'));
    const escapedRoot = root.replaceAll("'", "''");
    const escapedHelper = helperPath.replaceAll("'", "''");
    try {
      const result = powershell(`
        . '${escapedHelper}'
        $created = New-PrivateEnvironmentFile -RuntimeRoot '${escapedRoot}' -RunId 'abc12345' -Lines @('RESTORE_PASSWORD=test-only')
        $directoryAcl = (New-Object System.IO.DirectoryInfo($created.Directory)).GetAccessControl()
        $fileAcl = (New-Object System.IO.FileInfo($created.Path)).GetAccessControl()
        [pscustomobject]@{
          Directory = $created.Directory
          Path = $created.Path
          DirectoryProtected = $directoryAcl.AreAccessRulesProtected
          FileOwners = @($fileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq 'Allow' | Select-Object -ExpandProperty IdentityReference -Unique).Count
        } | ConvertTo-Json -Compress
      `);
      expect(result.status, result.stderr).toBe(0);
      const details = JSON.parse(result.stdout.trim()) as {
        Directory: string; Path: string; DirectoryProtected: boolean; FileOwners: number;
      };
      expect(details.DirectoryProtected).toBe(true);
      expect(details.FileOwners).toBe(1);
      expect(await readFile(details.Path, 'utf8')).toBe('RESTORE_PASSWORD=test-only\r\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['create', 'write', 'flush'] as const)(
    'removes the partial private credential context without masking an injected %s failure',
    async (stage) => {
      // Break caught: setup throws before returning its cleanup context, leaving a secret file or directory behind.
      const root = await mkdtemp(join(tmpdir(), 'task18-private-failure-'));
      const escapedRoot = root.replaceAll("'", "''");
      const escapedHelper = helperPath.replaceAll("'", "''");
      const originalFailure = `original-${stage}-failure`;
      const privateDirectory = join(root, 'restore-deadbeef');
      const fakeBoundary = stage === 'create'
        ? `
          function Open-PrivateEnvironmentStream {
            param([string] $Path, [object] $WindowsAcl, [object] $UnixOptions)
            [System.IO.File]::WriteAllText($Path, 'partial-secret')
            throw '${originalFailure}'
          }
        `
        : `
          function Write-PrivateEnvironmentLines {
            param([System.IO.Stream] $Stream, [string[]] $Lines)
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('partial-secret')
            $Stream.Write($bytes, 0, $bytes.Length)
            ${stage === 'flush' ? '$Stream.Flush()' : ''}
            throw '${originalFailure}'
          }
        `;
      try {
        const result = powershell(`
          . '${escapedHelper}'
          ${fakeBoundary}
          $observed = $null
          try {
            New-PrivateEnvironmentFile -RuntimeRoot '${escapedRoot}' -RunId 'deadbeef' -Lines @('RESTORE_PASSWORD=test-only') | Out-Null
            $observed = 'injected failure was not observed'
          } catch {
            $observed = $_.Exception.Message
          }
          if ($observed -notlike '*${originalFailure}*') { throw "Original failure was masked: $observed" }
          if (Test-Path -LiteralPath '${privateDirectory.replaceAll("'", "''")}') { throw 'Partial private context remains' }
          'cleanup-passed'
        `);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('cleanup-passed');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('rejects Docker Compose below 2.34.0 through the real command boundary', async () => {
    // Break caught: --env-from-file is attempted only after the long suite on an unsupported Compose CLI.
    const root = await mkdtemp(join(tmpdir(), 'task18-fake-docker-'));
    const fakeDocker = join(root, 'docker.cmd');
    const escapedHelper = helperPath.replaceAll("'", "''");
    const escapedDocker = fakeDocker.replaceAll("'", "''");
    try {
      await writeFile(fakeDocker, [
        '@echo off',
        'if "%1 %2 %3"=="compose version --short" (echo 2.33.9& exit /b 0)',
        'if "%1 %2"=="buildx version" (echo github.com/docker/buildx 0.20.0& exit /b 0)',
        'if "%1"=="version" (echo 27.0.0& exit /b 0)',
        'exit /b 1'
      ].join('\r\n'));
      const rejected = powershell(`. '${escapedHelper}'; Assert-DockerCapabilities -Docker '${escapedDocker}'`);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain('Docker Compose 2.34.0 or newer is required');

      await writeFile(fakeDocker, (await readFile(fakeDocker, 'utf8')).replace('2.33.9', '2.34.0'));
      const accepted = powershell(`. '${escapedHelper}'; Assert-DockerCapabilities -Docker '${escapedDocker}'`);
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
