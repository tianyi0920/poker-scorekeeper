$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'release/release-helpers.ps1')

function Invoke-External {
  param([Parameter(Mandatory)][string] $File, [Parameter(Mandatory)][string[]] $Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "External command failed with exit code $LASTEXITCODE" }
}

function Assert-PortAvailable {
  param([Parameter(Mandatory)][int] $Port)
  $client = New-Object System.Net.Sockets.TcpClient
  $connected = $false
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($attempt.AsyncWaitHandle.WaitOne(250)) {
      try {
        $client.EndConnect($attempt)
        $connected = $client.Connected
      } catch { $connected = $false }
    }
  } finally {
    $client.Dispose()
  }
  if ($connected) { throw "Release verification port $Port is already in use" }
}

$node = (Get-Command node -ErrorAction Stop).Source
$pnpmCli = $env:npm_execpath
if ([string]::IsNullOrWhiteSpace($pnpmCli) -or -not (Test-Path -LiteralPath $pnpmCli -PathType Leaf)) {
  throw 'Release verification must be launched through the pinned pnpm package manager'
}
$pnpmVersion = (& $node $pnpmCli --version).Trim()
if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '10.15.1') {
  throw "pnpm 10.15.1 is required"
}

# Docker is a mandatory release capability and must fail before the long local gates.
$docker = (Get-Command docker -ErrorAction Stop).Source
Assert-DockerCapabilities -Docker $docker

Write-Output 'gate: pnpm install --frozen-lockfile'
Invoke-External $node @($pnpmCli, 'install', '--frozen-lockfile')
Invoke-External $node @('scripts/database/run-with-test-env.mjs', '--check-only')

Write-Output 'gate: pnpm typecheck'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, 'typecheck')
Write-Output 'gate: pnpm test'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, 'test')
Write-Output 'gate: API test:integration'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, '--filter', '@poker/api', 'test:integration')
Write-Output 'gate: pnpm exec playwright test'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, 'exec', 'playwright', 'test')
Write-Output 'gate: pnpm build'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, 'build')

$runId = ([Guid]::NewGuid().ToString('N').Substring(0, 8)).ToLowerInvariant()
$git = (Get-Command git -ErrorAction Stop).Source
$deploymentId = Get-ReleaseDeploymentId -Git $git -RepositoryRoot $PSScriptRoot -RunId $runId
$previousDeploymentId = [Environment]::GetEnvironmentVariable('DEPLOYMENT_ID', 'Process')
$env:DEPLOYMENT_ID = $deploymentId
$project = "poker18verify$runId"
if ($project -notmatch '^poker18verify[a-f0-9]{8}$') { throw 'Unsafe Compose project name' }
$compose = @('compose', '-p', $project, '-f', 'docker-compose.test.yml')
$restoreDatabase = 'poker_scorekeeper_restore_test'
$restoreUser = "t18r$runId"
$restorePassword = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$restoreUserCreated = $false
$composeStarted = $false
$restoreEnvironmentContext = $null

try {
  Write-Output 'gate: docker build'
  Invoke-External $docker @(
    'build', '--build-arg', "DEPLOYMENT_ID=$deploymentId", '-t', 'poker-scorekeeper:verify', '.'
  )
  Invoke-External $docker ($compose + @('config', '--quiet'))
  Write-Output 'gate: docker compose migration and health'
  Assert-PortAvailable -Port 3000
  $composeStarted = $true
  Invoke-External $docker ($compose + @('up', '-d', '--build'))
  Wait-ApplicationHealthy -BaseUri 'http://127.0.0.1:3000'

  Invoke-External $docker ($compose + @('exec', '-T', '-e', "TASK18_DRILL_RUN_ID=$runId", 'app', 'node', 'scripts/database/seed-release-drill.mjs'))
  Write-Output 'gate: docker compose restart app and persistent volume'
  Invoke-External $docker ($compose + @('restart', 'app'))
  Wait-ApplicationHealthy -BaseUri 'http://127.0.0.1:3000'
  Invoke-External $docker ($compose + @('exec', '-T', 'app', 'sh', '-lc', 'test -n "$(find /data/avatars -mindepth 1 -maxdepth 1 -type f -name ''t18usr*.webp'' -print -quit)"'))

  Write-Output 'gate: backup.sh'
  Invoke-External $docker ($compose + @('exec', '-T', 'app', 'sh', 'scripts/backup/backup.sh'))
  $restoreStamp = (& $docker @($compose + @('exec', '-T', 'app', 'cat', '/data/backups/latest-stamp'))).Trim()
  if ($LASTEXITCODE -ne 0 -or $restoreStamp -notmatch '^[0-9]{8}T[0-9]{6}Z$') { throw 'Invalid backup stamp' }

  $runtimeDirectory = Join-Path (Get-Location) 'test-results/task18-runtime'
  $restoreUrl = "mysql://$restoreUser`:$restorePassword@mysql`:3306/$restoreDatabase"
  $restoreEnvironmentContext = New-PrivateEnvironmentFile -RuntimeRoot $runtimeDirectory -RunId $runId -Lines @(
    "TASK18_RESTORE_USER=$restoreUser",
    "TASK18_RESTORE_PASSWORD=$restorePassword",
    'MYSQL_HOST=mysql',
    'MYSQL_PORT=3306',
    "MYSQL_USER=$restoreUser",
    "MYSQL_PASSWORD=$restorePassword",
    "RESTORE_DATABASE=$restoreDatabase",
    "CONFIRM_RESTORE_DATABASE=$restoreDatabase",
    "CONFIRM_RESTORE_ACTION=RESTORE $restoreDatabase",
    "SQL_ARCHIVE=/data/backups/mysql-$restoreStamp.sql.gz",
    "AVATAR_ARCHIVE=/data/backups/avatars-$restoreStamp.tar.gz",
    "MANIFEST_FILE=/data/backups/manifest-$restoreStamp.txt",
    "CHECKSUM_FILE=/data/backups/checksums-$restoreStamp.txt",
    'RESTORE_AVATAR_PARENT=/data/restore',
    'RESTORE_AVATAR_ROOT=/data/restore/avatars',
    "TASK18_DRILL_RUN_ID=$runId",
    'PORT=3001',
    'PUBLIC_ORIGIN=http://127.0.0.1:3001',
    "DATABASE_URL=$restoreUrl",
    'AVATAR_ROOT=/data/restore/avatars'
  )
  $restoreEnvironmentFile = $restoreEnvironmentContext.Path

  $createRestoreUser = 'set -eu; MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "CREATE USER ''$TASK18_RESTORE_USER''@''%'' IDENTIFIED BY ''$TASK18_RESTORE_PASSWORD''; GRANT ALL PRIVILEGES ON poker_scorekeeper_restore_test.* TO ''$TASK18_RESTORE_USER''@''%'';"'
  "$restoreUser`n$restorePassword" | & $docker @($compose + @('exec', '-T', 'mysql', 'sh', '-lc', "IFS= read -r TASK18_RESTORE_USER; IFS= read -r TASK18_RESTORE_PASSWORD; export TASK18_RESTORE_USER TASK18_RESTORE_PASSWORD; $createRestoreUser"))
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the isolated restore account' }
  $restoreUserCreated = $true

  Write-Output 'gate: restore.sh into poker_scorekeeper_restore_test'
  Invoke-External $docker ($compose + @('run', '--rm', '-T', '--no-deps', '--env-from-file', $restoreEnvironmentFile, '--entrypoint', 'sh', 'app', 'scripts/backup/restore.sh'))

  $avatarFile = (& $docker @($compose + @('run', '--rm', '-T', '--no-deps', '--env-from-file', $restoreEnvironmentFile, '--entrypoint', 'node', 'app', 'scripts/database/assert-restored-data.mjs', '--print-avatar-path'))).Trim()
  if ($LASTEXITCODE -ne 0 -or $avatarFile -notmatch '^[a-z0-9-]+\.webp$') { throw 'Restored data assertion failed' }

  $restoreContainer = "$project-restore-app"
  Assert-PortAvailable -Port 3001
  Invoke-External $docker ($compose + @('run', '-d', '--name', $restoreContainer, '--no-deps', '--env-from-file', $restoreEnvironmentFile, '-p', '127.0.0.1:3001:3001', 'app'))
  Wait-ApplicationHealthy -BaseUri 'http://127.0.0.1:3001'
  $previousRestoredBaseUrl = $env:RESTORED_BASE_URL
  $previousDrillRunId = $env:TASK18_DRILL_RUN_ID
  try {
    $env:RESTORED_BASE_URL = 'http://127.0.0.1:3001'
    $env:TASK18_DRILL_RUN_ID = $runId
    Invoke-External $node @('scripts/database/assert-restored-api.mjs')
  } finally {
    if ($null -eq $previousRestoredBaseUrl) { Remove-Item Env:RESTORED_BASE_URL -ErrorAction SilentlyContinue }
    else { $env:RESTORED_BASE_URL = $previousRestoredBaseUrl }
    if ($null -eq $previousDrillRunId) { Remove-Item Env:TASK18_DRILL_RUN_ID -ErrorAction SilentlyContinue }
    else { $env:TASK18_DRILL_RUN_ID = $previousDrillRunId }
  }
  $avatarResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:3001/avatars/uploads/$avatarFile"
  if ($avatarResponse.StatusCode -ne 200) { throw 'Restored avatar did not load from the restored image' }
  Write-Output 'release verification passed'
} finally {
  if ($restoreUserCreated) {
    $dropRestoreUser = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP USER IF EXISTS ''$TASK18_RESTORE_USER''@''%''"'
    $restoreUser | & $docker @($compose + @('exec', '-T', 'mysql', 'sh', '-lc', "IFS= read -r TASK18_RESTORE_USER; export TASK18_RESTORE_USER; $dropRestoreUser")) | Out-Null
  }
  if ($composeStarted) {
    & $docker @($compose + @('down', '-v', '--remove-orphans')) | Out-Null
  }
  if ($null -ne $restoreEnvironmentContext) {
    Remove-PrivateEnvironmentFile -Created $restoreEnvironmentContext
  }
  if ($null -eq $previousDeploymentId) {
    Remove-Item Env:DEPLOYMENT_ID -ErrorAction SilentlyContinue
  } else {
    $env:DEPLOYMENT_ID = $previousDeploymentId
  }
}
