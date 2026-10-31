$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false

$root = Join-Path $env:RUNNER_TEMP ('oracle-windows-' + [guid]::NewGuid().ToString('N'))
$account = 'oracle_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$accountName = "$env:COMPUTERNAME\$account"
$server = $null
$createdAccount = $false
$leaseId = $null
New-Item -ItemType Directory -Path $root | Out-Null

function Download-ReleaseAsset([string]$repository, [string]$pattern, [string]$destination) {
  $headers = @{ Accept = 'application/vnd.github+json'; Authorization = "Bearer $env:GH_TOKEN" }
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repository/releases/latest"
  $assets = @($release.assets | Where-Object { $_.name -match $pattern })
  if ($assets.Count -ne 1) { throw "Expected exactly one $repository asset matching $pattern" }
  $asset = $assets[0]
  Write-Host "Downloading $repository $($release.tag_name) $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $destination
  if ($asset.digest) {
    $expected = $asset.digest -replace '^sha256:', ''
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) { throw "Digest mismatch for $($asset.name)" }
  }
}

function Assert-NativeSuccess([string]$name) {
  if ($LASTEXITCODE -ne 0) { throw "$name exited $LASTEXITCODE" }
}

try {
  $sshZip = Join-Path $root 'openssh.zip'
  $crabboxZip = Join-Path $root 'crabbox.zip'
  $zstdZip = Join-Path $root 'zstd.zip'
  Download-ReleaseAsset 'PowerShell/Win32-OpenSSH' '^OpenSSH-Win64\.zip$' $sshZip
  Download-ReleaseAsset 'openclaw/crabbox' '^crabbox_.*_windows_amd64\.zip$' $crabboxZip
  Download-ReleaseAsset 'facebook/zstd' '^zstd-.*-win64\.zip$' $zstdZip
  $sshDir = Join-Path $root 'openssh'
  $crabboxDir = Join-Path $root 'crabbox-bin'
  $zstdDir = Join-Path $root 'zstd'
  Expand-Archive -LiteralPath $sshZip -DestinationPath $sshDir
  Expand-Archive -LiteralPath $crabboxZip -DestinationPath $crabboxDir
  Expand-Archive -LiteralPath $zstdZip -DestinationPath $zstdDir
  $sshd = (Get-ChildItem -LiteralPath $sshDir -Filter sshd.exe -Recurse | Select-Object -First 1).FullName
  $ssh = (Get-ChildItem -LiteralPath $sshDir -Filter ssh.exe -Recurse | Select-Object -First 1).FullName
  $keygen = (Get-ChildItem -LiteralPath $sshDir -Filter ssh-keygen.exe -Recurse | Select-Object -First 1).FullName
  $sftp = (Get-ChildItem -LiteralPath $sshDir -Filter sftp-server.exe -Recurse | Select-Object -First 1).FullName
  $crabbox = (Get-ChildItem -LiteralPath $crabboxDir -Filter crabbox.exe -Recurse | Select-Object -First 1).FullName
  $zstd = (Get-ChildItem -LiteralPath $zstdDir -Filter zstd.exe -Recurse | Select-Object -First 1).FullName
  if (-not ($sshd -and $ssh -and $keygen -and $sftp -and $crabbox -and $zstd)) { throw 'A required downloaded executable is absent' }

  $toolDir = Join-Path $root 'tools'
  $piVersion = (Get-Content -Raw package.json | ConvertFrom-Json).devDependencies.'@earendil-works/pi-coding-agent'
  & npm.cmd install -g --prefix $toolDir --allow-scripts=agent-browser agent-browser "@earendil-works/pi-coding-agent@$piVersion"
  Assert-NativeSuccess 'agent-browser and Pi install'
  & C:\msys64\usr\bin\pacman.exe -Sy --noconfirm --needed rsync
  Assert-NativeSuccess 'rsync install'
  $env:PATH = "$toolDir;$([IO.Path]::GetDirectoryName($zstd));$env:PATH;C:\msys64\usr\bin"
  Write-Host "Candidate $(git rev-parse HEAD) tool versions: node=$(node.exe --version) npm=$(npm.cmd --version) browser=$(agent-browser.cmd --version) pi=$(pi.cmd --version)"
  & $crabbox --version
  Assert-NativeSuccess 'crabbox version'

  $password = ConvertTo-SecureString -AsPlainText -Force ([guid]::NewGuid().ToString('N') + 'Aa1!')
  New-LocalUser -Name $account -Password $password -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $createdAccount = $true
  $credential = [System.Management.Automation.PSCredential]::new($accountName, $password)
  if (Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.Name -ieq $accountName }) {
    throw 'Diagnostic account unexpectedly belongs to Administrators'
  }
  & icacls.exe $root /grant "${accountName}:(OI)(CI)F" | Out-Null
  Assert-NativeSuccess 'grant task directory'

  $hostKey = Join-Path $root 'host_ed25519'
  $clientKey = Join-Path $root 'client_ed25519'
  & $keygen -q -t ed25519 -N '' -f $hostKey
  Assert-NativeSuccess 'host key generation'
  & $keygen -q -t ed25519 -N '' -f $clientKey
  Assert-NativeSuccess 'client key generation'
  $authorizedKeys = Join-Path $root 'authorized_keys'
  Set-Content -LiteralPath $authorizedKeys -Value ((Get-Content -Raw -LiteralPath "$clientKey.pub").Trim()) -Encoding ascii
  $caller = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($path in @($hostKey, $authorizedKeys)) {
    & icacls.exe $path /inheritance:r /grant:r "${accountName}:(F)" 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
    Assert-NativeSuccess "restrict $path"
    & icacls.exe $path /remove:g $caller | Out-Null
    Assert-NativeSuccess "remove creator access from $path"
    & icacls.exe $path /setowner $accountName | Out-Null
    Assert-NativeSuccess "set owner for $path"
  }
  & icacls.exe $clientKey /inheritance:r /grant:r "${caller}:(F)" 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
  Assert-NativeSuccess 'restrict client key'

  $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $socket.Start()
  $port = $socket.LocalEndpoint.Port
  $socket.Stop()
  $serverConfig = Join-Path $root 'sshd_config'
  $serverLog = Join-Path $root 'sshd.log'
  $serverPid = Join-Path $root 'sshd.pid'
  $config = @(
    "Port $port",
    'ListenAddress 127.0.0.1',
    "HostKey $($hostKey.Replace('\', '/'))",
    "AuthorizedKeysFile $($authorizedKeys.Replace('\', '/'))",
    "PidFile $($serverPid.Replace('\', '/'))",
    "Subsystem sftp $($sftp.Replace('\', '/'))",
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'StrictModes yes',
    'LogLevel DEBUG2'
  ) -join "`n"
  Set-Content -LiteralPath $serverConfig -Value $config -Encoding ascii
  $configuration = Start-Process -FilePath $sshd -ArgumentList @('-t', '-f', $serverConfig, '-E', $serverLog) -Credential $credential -LoadUserProfile -WindowStyle Hidden -Wait -PassThru
  if ($configuration.ExitCode -ne 0) { throw "sshd configuration exited $($configuration.ExitCode)" }
  $server = Start-Process -FilePath $sshd -ArgumentList @('-D', '-f', $serverConfig, '-E', $serverLog) -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru
  $listening = $false
  for ($i = 0; $i -lt 100 -and -not $listening; $i++) {
    Start-Sleep -Milliseconds 200
    $server.Refresh()
    if ($server.HasExited) { throw "sshd exited $($server.ExitCode)" }
    $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Address.Equals([Net.IPAddress]::Loopback) -and $_.Port -eq $port }).Count -gt 0
  }
  if (-not $listening) { throw 'sshd did not listen on loopback' }
  Write-Host "Unprivileged task-owned sshd listening on 127.0.0.1:$port"

  $knownHosts = Join-Path $root 'known_hosts'
  $hostPublic = (Get-Content -Raw -LiteralPath "$hostKey.pub").Trim()
  Set-Content -LiteralPath $knownHosts -Value "[127.0.0.1]:$port $hostPublic" -Encoding ascii
  $sshArgs = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts", '-i', $clientKey, '-p', "$port", "$account@127.0.0.1")
  $identity = & $ssh @sshArgs 'whoami && whoami /groups'
  Assert-NativeSuccess 'native SSH identity probe'
  $identity | ForEach-Object { Write-Host $_ }
  if (-not ($identity -match [regex]::Escape($accountName))) { throw "SSH target identity is not $accountName" }
  if ($identity -match 'S-1-5-32-544') { throw 'SSH target belongs to Administrators' }
  Write-Host 'Verified task-owned native SSH account is not an administrator.'

  $env:CRABBOX_SSH_KEY = $clientKey
  $workRoot = Join-Path $root 'workspace'
  $base = @('--provider', 'static-ssh', '--target', 'windows', '--windows-mode', 'normal', '--static-host', '127.0.0.1', '--static-port', "$port", '--static-user', $account, '--static-work-root', $workRoot)
  & $crabbox doctor @base --doctor-probe-ssh
  Assert-NativeSuccess 'crabbox doctor'
  $warmup = & $crabbox warmup @base --slug oracle-windows-diagnostic --keep
  Assert-NativeSuccess 'crabbox warmup'
  $warmup | ForEach-Object { Write-Host $_ }
  $leaseMatch = ([string]::Join("`n", $warmup)) -match '\bleased\s+(\S+)|\blease=(\S+)'
  if ($leaseMatch) { $leaseId = if ($Matches[1]) { $Matches[1] } else { $Matches[2] } }
  if (-not $leaseId) { $leaseId = 'oracle-windows-diagnostic' }
  $toolsCommand = '$node = (node.exe --version).Trim(); Write-Host "REMOTE_NODE=$node"; if ([int]($node.TrimStart("v").Split(".")[0]) -lt 24) { exit 1 }; if (-not (Get-Command agent-browser.cmd -ErrorAction SilentlyContinue)) { exit 1 }; agent-browser.cmd --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; pi.cmd --version; exit $LASTEXITCODE'
  & $crabbox run @base --id $leaseId --allow-env PATH --allow-env Path --fresh-sync --shell $toolsCommand
  Assert-NativeSuccess 'Windows target tools'
  $platformCommand = & node.exe --input-type=module -e 'import config from "./platform-smoke.config.mjs"; import { buildPlatformBuildCommand } from "./scripts/platform-smoke/targets.mjs"; process.stdout.write(buildPlatformBuildCommand("windows-native", config.packageName, config.nodeValidationMajor));'
  Assert-NativeSuccess 'generate platform-build command'
  & $crabbox run @base --id $leaseId --allow-env PATH --allow-env Path --fresh-sync --shell $platformCommand
  Assert-NativeSuccess 'Windows platform-build suite'

  $realCommand = & node.exe --input-type=module -e 'import config from "./platform-smoke.config.mjs"; import { buildRealExtensionCommand } from "./scripts/platform-smoke/targets.mjs"; process.stdout.write(buildRealExtensionCommand("windows-native", config));'
  Assert-NativeSuccess 'generate real-extension command'
  & $crabbox run @base --id $leaseId --allow-env PATH --allow-env Path --no-sync --shell $realCommand
  Assert-NativeSuccess 'Windows real-extension suite'
  Write-Host 'STATIC_SSH_DIAGNOSTIC_AND_SUITES_OK'
} finally {
  if ($leaseId) { & $crabbox stop @base --id $leaseId; if ($LASTEXITCODE -ne 0) { Write-Warning "Crabbox stop exited $LASTEXITCODE" } }
  if ($server) { $server.Refresh(); if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force } }
  if (Test-Path -LiteralPath $serverLog -ErrorAction SilentlyContinue) {
    Write-Host '--- task-owned sshd log ---'
    Get-Content -LiteralPath $serverLog -Tail 120
  }
  if ($createdAccount) { Remove-LocalUser -Name $account }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
