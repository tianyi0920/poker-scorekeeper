function Assert-DockerCapabilities {
  param([Parameter(Mandatory)][string] $Docker)

  & $Docker version --format '{{.Server.Version}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is unavailable' }
  & $Docker buildx version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Buildx is unavailable' }
  $composeText = (& $Docker compose version --short).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable' }
  try {
    $composeVersion = [version]($composeText.TrimStart('v').Split('-')[0])
  } catch {
    throw 'Docker Compose returned an unrecognized version'
  }
  if ($composeVersion -lt [version]'2.34.0') {
    throw 'Docker Compose 2.34.0 or newer is required'
  }
}

function Get-ReleaseDeploymentId {
  param(
    [Parameter(Mandatory)][string] $Git,
    [Parameter(Mandatory)][string] $RepositoryRoot,
    [Parameter(Mandatory)][string] $RunId
  )

  if ($RunId -notmatch '^[a-f0-9]{8}$') { throw 'Release run ID is invalid' }
  $revisionOutput = & $Git -C $RepositoryRoot rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the release Git revision' }
  $revision = ($revisionOutput -join '').Trim().ToLowerInvariant()
  if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Release Git revision is invalid' }
  $deploymentId = "releaseverify-$revision-$RunId"
  if ($deploymentId -notmatch '^[a-z0-9][a-z0-9._-]{7,63}$') {
    throw 'Release deployment ID is invalid'
  }
  return $deploymentId
}

function Wait-HealthResponse {
  param(
    [Parameter(Mandatory)][string] $Uri,
    [Parameter(Mandatory)][bool] $RequireDatabase
  )
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $Uri
      $body = $response.Content | ConvertFrom-Json
      if ($response.StatusCode -eq 200 -and $body.status -eq 'ok' -and (-not $RequireDatabase -or $body.database -eq 'ok')) { return }
    } catch {
      # The container may still be starting or waiting for its database.
    }
    Start-Sleep -Seconds 2
  }
  throw "Health endpoint did not become ready: $Uri"
}

function Wait-ApplicationHealthy {
  param([Parameter(Mandatory)][string] $BaseUri)
  Wait-HealthResponse -Uri "$BaseUri/api/health/live" -RequireDatabase $false
  Wait-HealthResponse -Uri "$BaseUri/api/health/ready" -RequireDatabase $true
}

function Open-PrivateEnvironmentStream {
  param(
    [Parameter(Mandatory)][string] $Path,
    [object] $WindowsAcl,
    [object] $UnixOptions
  )
  if ($null -ne $WindowsAcl) {
    return New-Object System.IO.FileStream(
      $Path,
      [System.IO.FileMode]::CreateNew,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::None,
      $WindowsAcl
    )
  }
  return New-Object System.IO.FileStream($Path, $UnixOptions)
}

function Write-PrivateEnvironmentLines {
  param(
    [Parameter(Mandatory)][System.IO.Stream] $Stream,
    [Parameter(Mandatory)][string[]] $Lines
  )
  $writer = New-Object System.IO.StreamWriter($Stream, (New-Object System.Text.UTF8Encoding($false)))
  try {
    foreach ($line in $Lines) { $writer.WriteLine($line) }
    $writer.Flush()
  } catch {
    $writeFailure = $_
    try { $writer.Dispose() } catch { }
    throw $writeFailure
  }
  $writer.Dispose()
}

function New-PrivateEnvironmentFile {
  param(
    [Parameter(Mandatory)][string] $RuntimeRoot,
    [Parameter(Mandatory)][string] $RunId,
    [Parameter(Mandatory)][string[]] $Lines
  )
  if ($RunId -notmatch '^[a-f0-9]{8}$') { throw 'Unsafe private environment run id' }
  [System.IO.Directory]::CreateDirectory($RuntimeRoot) | Out-Null
  $privateDirectory = Join-Path $RuntimeRoot "restore-$RunId"
  $environmentPath = Join-Path $privateDirectory 'restore.env'
  if (Test-Path -LiteralPath $privateDirectory) { throw 'Private restore directory already exists' }

  $stream = $null
  try {
    if ($env:OS -eq 'Windows_NT') {
      $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetAccessRuleProtection($true, $false)
      $acl.SetOwner($identity)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      $acl.AddAccessRule($rule)
      [System.IO.Directory]::CreateDirectory($privateDirectory, $acl) | Out-Null
      $directoryInfo = New-Object System.IO.DirectoryInfo($privateDirectory)
      $createdAcl = $directoryInfo.GetAccessControl()
      if (-not $createdAcl.AreAccessRulesProtected) {
        throw 'Private restore directory ACL was not protected'
      }

      $fileAcl = New-Object System.Security.AccessControl.FileSecurity
      $fileAcl.SetAccessRuleProtection($true, $false)
      $fileAcl.SetOwner($identity)
      $fileRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      $fileAcl.AddAccessRule($fileRule)
      $stream = Open-PrivateEnvironmentStream -Path $environmentPath -WindowsAcl $fileAcl -UnixOptions $null
    } else {
      [System.IO.Directory]::CreateDirectory(
        $privateDirectory,
        [System.IO.UnixFileMode]::UserRead -bor
          [System.IO.UnixFileMode]::UserWrite -bor
          [System.IO.UnixFileMode]::UserExecute
      ) | Out-Null
      $options = New-Object System.IO.FileStreamOptions
      $options.Mode = [System.IO.FileMode]::CreateNew
      $options.Access = [System.IO.FileAccess]::Write
      $options.Share = [System.IO.FileShare]::None
      $options.UnixCreateMode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite
      $stream = Open-PrivateEnvironmentStream -Path $environmentPath -WindowsAcl $null -UnixOptions $options
    }
    Write-PrivateEnvironmentLines -Stream $stream -Lines $Lines
  } catch {
    $creationFailure = $_
    if ($null -ne $stream) {
      try { $stream.Dispose() } catch { }
    }
    try {
      if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
        Remove-Item -LiteralPath $environmentPath -Force
      }
    } catch { }
    try {
      if (Test-Path -LiteralPath $privateDirectory -PathType Container) {
        Remove-Item -LiteralPath $privateDirectory -Force
      }
    } catch { }
    throw $creationFailure
  }
  return [pscustomobject]@{ Directory = $privateDirectory; Path = $environmentPath }
}

function Remove-PrivateEnvironmentFile {
  param([Parameter(Mandatory)][psobject] $Created)
  if (Test-Path -LiteralPath $Created.Path -PathType Leaf) {
    Remove-Item -LiteralPath $Created.Path -Force
  }
  if (Test-Path -LiteralPath $Created.Directory -PathType Container) {
    Remove-Item -LiteralPath $Created.Directory -Force
  }
}
