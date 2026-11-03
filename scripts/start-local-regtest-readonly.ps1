# Dedicated new chain only. No wallet and no peer networking.
# RPC is restricted to public status/descriptor reads and shutdown; transaction operations
# are not authorized. No real user's data directory or RPC cookie is inspected.
$ErrorActionPreference = 'Stop'
$runtimeRoot = 'C:\progetti\work\integration-local'
$runtimeBin = Join-Path $runtimeRoot 'bitcoin\runtime\bitcoin-32.1\bin'
$runtimeData = Join-Path $runtimeRoot 'regtest-readonly'
$runtimeMarker = Join-Path $runtimeData 'nap-isolated-regtest.marker'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeBin 'bitcoind.exe'))) { throw 'Verified Bitcoin binary missing.' }
if (Test-Path -LiteralPath $runtimeData) {
    if (-not (Test-Path -LiteralPath $runtimeMarker)) { throw 'Refusing an unmarked data directory.' }
} else {
    New-Item -ItemType Directory -Path $runtimeData | Out-Null
    'nap-market-isolated-regtest-readonly' | Set-Content -LiteralPath $runtimeMarker
}
$runtimeArguments = @(
    "-datadir=$runtimeData", '-regtest=1', '-server=1', '-disablewallet=1',
    '-networkactive=0', '-listen=0', '-dnsseed=0', '-discover=0',
    '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-rpcport=19443',
    '-rpcwhitelistdefault=1',
    '-rpcwhitelist=__cookie__:getblockchaininfo,getnetworkinfo,getrpcinfo,getdescriptorinfo,deriveaddresses,validateaddress,stop'
)
Start-Process -FilePath (Join-Path $runtimeBin 'bitcoind.exe') -WindowStyle Hidden -ArgumentList $runtimeArguments |
    Out-Null
Write-Output 'Dedicated wallet-free Regtest node start requested on localhost:19443.'
