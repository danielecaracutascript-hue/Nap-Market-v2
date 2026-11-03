#Requires -RunAsAdministrator
# Prerequisite only: installs WSL without a Linux distribution.
# Does not reboot, access project credentials, or start application services.
$ErrorActionPreference = 'Stop'
$runtimeDirectory = 'C:\progetti\work\integration-local'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$runtimeLog = Join-Path $runtimeDirectory 'wsl-install.log'
$runtimeResult = Join-Path $runtimeDirectory 'wsl-install-result.json'
try {
    & winget.exe install --id Microsoft.WSL --exact --source winget --disable-interactivity 2>&1 |
        Out-File -LiteralPath $runtimeLog -Encoding utf8
    $packageExit = $LASTEXITCODE
    # A previously installed package may make winget report no upgrade available.
    # WSL writes transient progress to stderr; PowerShell 5 must not treat it
    # as a terminating exception before the native exit code is inspected.
    $ErrorActionPreference = 'Continue'
    & wsl.exe --version 2>&1 | Out-File -LiteralPath $runtimeLog -Append -Encoding utf8
    $versionExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($versionExit -ne 0) {
        throw "WSL package unavailable after installation (winget exit $packageExit)."
    }
    $ErrorActionPreference = 'Continue'
    & wsl.exe --install --no-distribution 2>&1 |
        Out-File -LiteralPath $runtimeLog -Append -Encoding utf8
    $enableExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    [pscustomobject]@{
        PackageExit = $packageExit
        VersionExit = $versionExit
        EnableExit = $enableExit
        AutomaticRestart = $false
        Complete = $enableExit -eq 0 -or $enableExit -eq 3010
    } | ConvertTo-Json | Set-Content -LiteralPath $runtimeResult -Encoding utf8
} catch {
    [pscustomobject]@{ Complete = $false; Error = $_.Exception.Message; AutomaticRestart = $false } |
        ConvertTo-Json | Set-Content -LiteralPath $runtimeResult -Encoding utf8
    exit 1
}
