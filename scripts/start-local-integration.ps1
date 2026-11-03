# Starts only the dedicated synthetic Supabase environment prepared for this repo.
# Does not link to a hosted project or read marketplace .env files.
$ErrorActionPreference = 'Stop'
$runtimeRoot = 'C:\progetti\work\integration-local'
$runtimeCli = Join-Path $runtimeRoot 'tools\node_modules\.bin\supabase.cmd'
$runtimeStack = Join-Path $runtimeRoot 'stack'
$runtimeDockerBin = 'C:\Users\Daniele\AppData\Local\Programs\DockerDesktop\resources\bin'
$runtimeDockerShim = Join-Path $runtimeRoot 'loopback-bin'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDockerShim 'docker.exe'))) { throw 'Localhost-only Docker launcher is missing.' }
if (-not (Test-Path -LiteralPath $runtimeCli)) { throw 'Isolated Supabase CLI is not installed.' }
if (-not (Test-Path -LiteralPath (Join-Path $runtimeStack 'supabase\config.toml'))) { throw 'Isolated project is not initialized.' }
$runtimeConfigId = Select-String -LiteralPath (Join-Path $runtimeStack 'supabase\config.toml') -Pattern '^project_id\s*=\s*"nap-market-isolated-20261030"\s*$'
if (-not $runtimeConfigId) { throw 'Refusing a different Supabase project.' }
$runtimePreviousPath = $env:PATH
$runtimePreviousDockerHost = $env:DOCKER_HOST
try {
    $env:PATH = $runtimeDockerShim + ';' + $runtimeDockerBin + ';' + $env:PATH
    $env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
    $runtimeBinding = & (Join-Path $runtimeDockerBin 'docker.exe') network inspect nap-market-isolated-loopback --format '{{ index .Options "com.docker.network.bridge.host_binding_ipv4" }}'
    if ($LASTEXITCODE -ne 0 -or $runtimeBinding -ne '127.0.0.1') {
        throw 'Dedicated localhost-only Docker network is missing or incorrectly configured.'
    }
    $ErrorActionPreference = 'Continue'
    & $runtimeCli start --workdir $runtimeStack --network-id nap-market-isolated-loopback --exclude realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor,mailpit *> (Join-Path $runtimeRoot 'supabase-start.log')
    $runtimeExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    # The log may contain newly generated local-only credentials; never print it.
    [pscustomobject]@{ ExitCode = $runtimeExit; LogContainsLocalCredentials = $true } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'supabase-start-result.json') -Encoding utf8
    Write-Output "Supabase local start exit: $runtimeExit"
    exit $runtimeExit
} finally {
    $env:PATH = $runtimePreviousPath
    $env:DOCKER_HOST = $runtimePreviousDockerHost
}
