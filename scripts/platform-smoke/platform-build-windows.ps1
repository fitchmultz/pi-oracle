param(
  [string]$PackageName = "pi-oracle",
  [int]$NodeValidationMajor = 24
)

$ErrorActionPreference = "Continue"

function Exit-CodeFromLastCommand {
  if ($null -ne $global:LASTEXITCODE) { return [int]$global:LASTEXITCODE }
  if ($?) { return 0 }
  return 1
}

function Write-SectionFile {
  param([string]$Name, [string]$Path)
  Write-Output "--- $Name START ---"
  if (Test-Path -LiteralPath $Path) {
    Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
  }
  Write-Output "--- $Name END ---"
}

Write-Output "Starting pi-oracle platform-build in $(Get-Location) at $(Get-Date -Format o)"
$SourceRoot = (Get-Location).Path
$RunRoot = Join-Path $SourceRoot (Join-Path ".platform-smoke-runs" ("platform-build-" + (Get-Date -Format "yyyyMMddTHHmmssZ") + "-" + $PID))
$PackDir = Join-Path $RunRoot "pack"
$TestWorkspace = Join-Path $RunRoot "test-workspace"
$PiProject = Join-Path $RunRoot "pi-project"
New-Item -ItemType Directory -Force -Path $PackDir, $TestWorkspace, $PiProject | Out-Null
Write-Output "PLATFORM_RUN_ROOT=$RunRoot"
Write-Output "PLATFORM_TEST_WORKSPACE=$TestWorkspace"
Write-Output "PLATFORM_PI_PROJECT=$PiProject"

$NodeVersion = (& node.exe --version).Trim()
$NodeMajor = [int](($NodeVersion -replace '^v', '').Split('.')[0])
if ($NodeMajor -ge $NodeValidationMajor) { $NODE_VERSION_EXIT = 0 } else { $NODE_VERSION_EXIT = 1 }
Write-Output "PLATFORM_NODE_VERSION=$NodeVersion"
Write-Output "PLATFORM_NODE_VERSION_EXIT=$NODE_VERSION_EXIT"

Write-Output "=== npm ci ==="
& npm.cmd ci *>&1
$CI_EXIT = Exit-CodeFromLastCommand
Write-Output "PLATFORM_NPM_CI_EXIT=$CI_EXIT"

Write-Output "=== platform dependencies ==="
$DEPS_EXIT = 0
$ZstdCommand = Get-Command zstd -ErrorAction SilentlyContinue
if ($ZstdCommand) { $ZSTD_INSTALL_EXIT = 0 } else { Write-Output "zstd missing on Windows target PATH; update pi-extension-windows-template/crabbox-ready"; $ZSTD_INSTALL_EXIT = 1 }
if ($ZSTD_INSTALL_EXIT -ne 0) { $DEPS_EXIT = 1 }
$AgentBrowserCommand = Get-Command agent-browser -ErrorAction SilentlyContinue
if (-not $AgentBrowserCommand) { $AgentBrowserCommand = Get-Command agent-browser.cmd -ErrorAction SilentlyContinue }
if ($AgentBrowserCommand) { $AGENT_BROWSER_INSTALL_EXIT = 0; $AgentBrowserPath = $AgentBrowserCommand.Source } else { Write-Output "agent-browser missing on Windows target PATH; update pi-extension-windows-template/crabbox-ready"; $AGENT_BROWSER_INSTALL_EXIT = 1; $AgentBrowserPath = "" }
if ($AGENT_BROWSER_INSTALL_EXIT -ne 0) { $DEPS_EXIT = 1 }
Write-Output "PLATFORM_ZSTD_INSTALL_EXIT=$ZSTD_INSTALL_EXIT"
Write-Output "PLATFORM_AGENT_BROWSER_INSTALL_EXIT=$AGENT_BROWSER_INSTALL_EXIT"
Write-Output "PLATFORM_DEPS_EXIT=$DEPS_EXIT"
if ($ZstdCommand) { Write-Output $ZstdCommand.Source }
if ($AgentBrowserPath) { Write-Output $AgentBrowserPath }

Write-Output "=== platform verification ==="
$PreviousAgentBrowserPath = $env:AGENT_BROWSER_PATH
$PreviousSanityProgress = $env:PI_ORACLE_SANITY_PROGRESS
$env:AGENT_BROWSER_PATH = $AgentBrowserPath
$env:PI_ORACLE_SANITY_PROGRESS = "1"
& npm.cmd run verify:oracle:platform *>&1
$TEST_EXIT = Exit-CodeFromLastCommand
if ($null -eq $PreviousAgentBrowserPath) { Remove-Item Env:\AGENT_BROWSER_PATH -ErrorAction SilentlyContinue } else { $env:AGENT_BROWSER_PATH = $PreviousAgentBrowserPath }
if ($null -eq $PreviousSanityProgress) { Remove-Item Env:\PI_ORACLE_SANITY_PROGRESS -ErrorAction SilentlyContinue } else { $env:PI_ORACLE_SANITY_PROGRESS = $PreviousSanityProgress }
Write-Output "PLATFORM_NPM_TEST_EXIT=$TEST_EXIT"

Write-Output "=== npm pack ==="
$NpmPackErr = Join-Path $PackDir "npm-pack.stderr.txt"
$PackOutput = @(& npm.cmd pack --silent 2> $NpmPackErr)
$PACK_EXIT = Exit-CodeFromLastCommand
Get-Content -LiteralPath $NpmPackErr -ErrorAction SilentlyContinue
$PackTarball = ($PackOutput | Select-Object -First 1)
if ($PackTarball) { $PackTarball = $PackTarball.Trim() }
Write-Output "PLATFORM_NPM_PACK_EXIT=$PACK_EXIT"
if ($PackTarball -and (Test-Path -LiteralPath $PackTarball)) {
  Move-Item -LiteralPath $PackTarball -Destination (Join-Path $PackDir $PackTarball) -Force
}
Write-Output "PLATFORM_PACKED_TARBALL=$PackTarball"
Set-Content -Path (Join-Path $PackDir "packed-tarball.txt") -Value $PackTarball

Write-Output "=== fixture workspace ==="
Copy-Item -LiteralPath package.json, README.md -Destination $TestWorkspace -ErrorAction SilentlyContinue
Copy-Item -LiteralPath extensions, prompts, docs -Destination $TestWorkspace -Recurse -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath (Join-Path $TestWorkspace "package.json")) -and (Test-Path -LiteralPath (Join-Path $TestWorkspace "README.md")) -and (Test-Path -LiteralPath (Join-Path $TestWorkspace "extensions")) -and (Test-Path -LiteralPath (Join-Path $TestWorkspace "prompts")) -and (Test-Path -LiteralPath (Join-Path $TestWorkspace "docs"))) {
  $FIXTURE_EXIT = 0
} else {
  $FIXTURE_EXIT = 1
}
Write-Output "PLATFORM_FIXTURE_EXIT=$FIXTURE_EXIT"

$PiCli = Join-Path (Get-Location) "node_modules\.bin\pi.cmd"
if (-not (Test-Path -LiteralPath $PiCli)) { $PiCli = Join-Path (Get-Location) "node_modules\.bin\pi" }
if (-not (Test-Path -LiteralPath $PiCli)) {
  $Command = Get-Command pi -ErrorAction SilentlyContinue
  $PiCli = $Command.Source
}
Write-Output "PLATFORM_PI_CLI=$PiCli"

$PackedNodeInstallOut = Join-Path $PackDir "packed-node-install.stdout.txt"
$PackedNodeInstallErr = Join-Path $PackDir "packed-node-install.stderr.txt"
$PiInstallOut = Join-Path $PackDir "pi-install.stdout.txt"
$PiInstallErr = Join-Path $PackDir "pi-install.stderr.txt"
$PiListOut = Join-Path $PackDir "pi-list.stdout.txt"
$PiListErr = Join-Path $PackDir "pi-list.stderr.txt"

Write-Output "=== pi install packed package ==="
$TarballPath = Join-Path $PackDir $PackTarball
if ($PackTarball -and $PiCli -and (Test-Path -LiteralPath $TarballPath)) {
  Push-Location $PiProject
  & npm.cmd init -y 1> $PackedNodeInstallOut 2> $PackedNodeInstallErr
  $NPM_INIT_EXIT = Exit-CodeFromLastCommand
  if ($NPM_INIT_EXIT -eq 0) {
    & npm.cmd install --no-save $TarballPath 1>> $PackedNodeInstallOut 2>> $PackedNodeInstallErr
    $PACKED_NODE_INSTALL_EXIT = Exit-CodeFromLastCommand
  } else {
    $PACKED_NODE_INSTALL_EXIT = $NPM_INIT_EXIT
  }
  if ($PACKED_NODE_INSTALL_EXIT -eq 0) {
    $PreviousPiOffline = $env:PI_OFFLINE
    $env:PI_OFFLINE = "1"
    & $PiCli install -l (Join-Path ".\node_modules" $PackageName) --approve 1> $PiInstallOut 2> $PiInstallErr
    $PI_INSTALL_EXIT = Exit-CodeFromLastCommand
    if ($null -eq $PreviousPiOffline) { Remove-Item Env:\PI_OFFLINE -ErrorAction SilentlyContinue } else { $env:PI_OFFLINE = $PreviousPiOffline }
  } else {
    Set-Content -LiteralPath $PiInstallErr -Value "packed npm install failed"
    $PI_INSTALL_EXIT = 1
  }
  Pop-Location
} else {
  Set-Content -LiteralPath $PackedNodeInstallErr -Value "missing pi cli or tarball"
  Set-Content -LiteralPath $PiInstallErr -Value "missing pi cli or tarball"
  $PACKED_NODE_INSTALL_EXIT = 1
  $PI_INSTALL_EXIT = 1
}
Write-Output "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PACKED_NODE_INSTALL_EXIT"
Write-SectionFile "PACKED_NODE_INSTALL_STDOUT" $PackedNodeInstallOut
Write-SectionFile "PACKED_NODE_INSTALL_STDERR" $PackedNodeInstallErr
Write-Output "PLATFORM_PI_INSTALL_EXIT=$PI_INSTALL_EXIT"
Write-SectionFile "PI_INSTALL_STDOUT" $PiInstallOut
Write-SectionFile "PI_INSTALL_STDERR" $PiInstallErr

Write-Output "=== pi list ==="
if ($PiCli) {
  Push-Location $PiProject
  $PreviousPiOffline = $env:PI_OFFLINE
  $env:PI_OFFLINE = "1"
  & $PiCli list --approve 1> $PiListOut 2> $PiListErr
  $PI_LIST_EXIT = Exit-CodeFromLastCommand
  if ($null -eq $PreviousPiOffline) { Remove-Item Env:\PI_OFFLINE -ErrorAction SilentlyContinue } else { $env:PI_OFFLINE = $PreviousPiOffline }
  Pop-Location
} else {
  Set-Content -LiteralPath $PiListErr -Value "missing pi cli"
  $PI_LIST_EXIT = 1
}
Write-Output "PLATFORM_PI_LIST_EXIT=$PI_LIST_EXIT"
Write-SectionFile "PI_LIST_STDOUT" $PiListOut
Write-SectionFile "PI_LIST_STDERR" $PiListErr

Write-Output "node=$NODE_VERSION_EXIT ci=$CI_EXIT deps=$DEPS_EXIT test=$TEST_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"
if ($NODE_VERSION_EXIT -ne 0 -or $CI_EXIT -ne 0 -or $DEPS_EXIT -ne 0 -or $TEST_EXIT -ne 0 -or $PACK_EXIT -ne 0 -or $FIXTURE_EXIT -ne 0 -or $PACKED_NODE_INSTALL_EXIT -ne 0 -or $PI_INSTALL_EXIT -ne 0 -or $PI_LIST_EXIT -ne 0) {
  Write-Output "PLATFORM_BUILD_FAILED: node=$NODE_VERSION_EXIT ci=$CI_EXIT deps=$DEPS_EXIT test=$TEST_EXIT pack=$PACK_EXIT fixture=$FIXTURE_EXIT packedNodeInstall=$PACKED_NODE_INSTALL_EXIT install=$PI_INSTALL_EXIT list=$PI_LIST_EXIT"
  exit 1
}
Write-Output "PLATFORM_BUILD_OK"
