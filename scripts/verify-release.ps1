$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-External {
  param([Parameter(Mandatory)][string] $File, [Parameter(Mandatory)][string[]] $Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "External command failed with exit code $LASTEXITCODE" }
}

function Wait-Ready {
  param([Parameter(Mandatory)][string] $Uri)
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $Uri
      if ($response.StatusCode -eq 200) { return }
    } catch { Start-Sleep -Seconds 2 }
  }
  throw "Health endpoint did not become ready: $Uri"
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
Invoke-External $node @($pnpmCli, 'exec', 'playwright', 'test')
Write-Output 'gate: pnpm build'
Invoke-External $node @('scripts/database/run-with-test-env.mjs', $node, $pnpmCli, 'build')

# Docker remains mandatory. Missing CLI, daemon, buildx, or Compose terminates the release gate.
$docker = (Get-Command docker -ErrorAction Stop).Source
Invoke-External $docker @('version', '--format', '{{.Server.Version}}')
Invoke-External $docker @('buildx', 'version')
Invoke-External $docker @('compose', 'version')

$runId = ([Guid]::NewGuid().ToString('N').Substring(0, 8)).ToLowerInvariant()
$project = "poker18verify$runId"
if ($project -notmatch '^poker18verify[a-f0-9]{8}$') { throw 'Unsafe Compose project name' }
$compose = @('compose', '-p', $project, '-f', 'docker-compose.test.yml')
$restoreDatabase = 'poker_scorekeeper_restore_test'
$restoreUser = "t18r$runId"
$restorePassword = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
$restoreUserCreated = $false
$composeStarted = $false

try {
  Write-Output 'gate: docker build'
  Invoke-External $docker @('build', '-t', 'poker-scorekeeper:verify', '.')
  Invoke-External $docker ($compose + @('config', '--quiet'))
  Write-Output 'gate: docker compose migration and health'
  $composeStarted = $true
  Invoke-External $docker ($compose + @('up', '-d', '--build'))
  Wait-Ready 'http://127.0.0.1:3000/api/health/ready'

  Invoke-External $docker ($compose + @('exec', '-T', '-e', "TASK18_DRILL_RUN_ID=$runId", 'app', 'node', 'scripts/database/seed-release-drill.mjs'))
  Write-Output 'gate: docker compose restart app and persistent volume'
  Invoke-External $docker ($compose + @('restart', 'app'))
  Wait-Ready 'http://127.0.0.1:3000/api/health/ready'
  Invoke-External $docker ($compose + @('exec', '-T', 'app', 'sh', '-lc', 'test -n "$(find /data/avatars -mindepth 1 -maxdepth 1 -type f -name ''t18usr*.webp'' -print -quit)"'))

  Write-Output 'gate: backup.sh'
  Invoke-External $docker ($compose + @('exec', '-T', 'app', 'sh', 'scripts/backup/backup.sh'))
  $restoreStamp = (& $docker @($compose + @('exec', '-T', 'app', 'cat', '/data/backups/latest-stamp'))).Trim()
  if ($LASTEXITCODE -ne 0 -or $restoreStamp -notmatch '^[0-9]{8}T[0-9]{6}Z$') { throw 'Invalid backup stamp' }

  $createRestoreUser = 'set -eu; MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "CREATE USER ''$TASK18_RESTORE_USER''@''%'' IDENTIFIED BY ''$TASK18_RESTORE_PASSWORD''; GRANT ALL PRIVILEGES ON poker_scorekeeper_restore_test.* TO ''$TASK18_RESTORE_USER''@''%'';"'
  Invoke-External $docker ($compose + @('exec', '-T', '-e', "TASK18_RESTORE_USER=$restoreUser", '-e', "TASK18_RESTORE_PASSWORD=$restorePassword", 'mysql', 'sh', '-lc', $createRestoreUser))
  $restoreUserCreated = $true

  Write-Output 'gate: restore.sh into poker_scorekeeper_restore_test'
  $restoreEnvironment = @(
    '-e', "MYSQL_USER=$restoreUser",
    '-e', "MYSQL_PASSWORD=$restorePassword",
    '-e', "RESTORE_DATABASE=$restoreDatabase",
    '-e', "CONFIRM_RESTORE_DATABASE=$restoreDatabase",
    '-e', "CONFIRM_RESTORE_ACTION=RESTORE $restoreDatabase",
    '-e', "SQL_ARCHIVE=/data/backups/mysql-$restoreStamp.sql.gz",
    '-e', "AVATAR_ARCHIVE=/data/backups/avatars-$restoreStamp.tar.gz",
    '-e', "MANIFEST_FILE=/data/backups/manifest-$restoreStamp.txt",
    '-e', "CHECKSUM_FILE=/data/backups/checksums-$restoreStamp.txt",
    '-e', 'RESTORE_AVATAR_PARENT=/data/restore',
    '-e', 'RESTORE_AVATAR_ROOT=/data/restore/avatars'
  )
  Invoke-External $docker ($compose + @('exec', '-T') + $restoreEnvironment + @('app', 'sh', 'scripts/backup/restore.sh'))

  $assertEnvironment = @('-e', "MYSQL_USER=$restoreUser", '-e', "MYSQL_PASSWORD=$restorePassword", '-e', "RESTORE_DATABASE=$restoreDatabase", '-e', 'RESTORE_AVATAR_ROOT=/data/restore/avatars', '-e', "TASK18_DRILL_RUN_ID=$runId")
  $avatarFile = (& $docker @($compose + @('exec', '-T') + $assertEnvironment + @('app', 'node', 'scripts/database/assert-restored-data.mjs', '--print-avatar-path'))).Trim()
  if ($LASTEXITCODE -ne 0 -or $avatarFile -notmatch '^[a-z0-9-]+\.webp$') { throw 'Restored data assertion failed' }

  $restoreUrl = "mysql://$restoreUser`:$restorePassword@mysql`:3306/$restoreDatabase"
  $restoreContainer = "$project-restore-app"
  Invoke-External $docker ($compose + @('run', '-d', '--name', $restoreContainer, '--no-deps', '-e', 'PORT=3001', '-e', 'PUBLIC_ORIGIN=http://127.0.0.1:3001', '-e', "DATABASE_URL=$restoreUrl", '-e', 'AVATAR_ROOT=/data/restore/avatars', '-p', '127.0.0.1:3001:3001', 'app'))
  Wait-Ready 'http://127.0.0.1:3001/api/health/ready'
  $avatarResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:3001/avatars/uploads/$avatarFile"
  if ($avatarResponse.StatusCode -ne 200) { throw 'Restored avatar did not load from the restored image' }
  Write-Output 'release verification passed'
} finally {
  if ($restoreUserCreated) {
    $dropRestoreUser = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP USER IF EXISTS ''$TASK18_RESTORE_USER''@''%''"'
    & $docker @($compose + @('exec', '-T', '-e', "TASK18_RESTORE_USER=$restoreUser", 'mysql', 'sh', '-lc', $dropRestoreUser)) | Out-Null
  }
  if ($composeStarted) {
    & $docker @($compose + @('down', '-v', '--remove-orphans')) | Out-Null
  }
}
