$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logRoot = Join-Path $env:LOCALAPPDATA 'TBH-DPS-dashboard\logs'
$logPath = Join-Path $logRoot 'feed-update.log'
$publishRoot = Join-Path $env:TEMP ('tbh-market-publish-' + [guid]::NewGuid().ToString('N'))
$remote = $null

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

try {
    Set-Location -LiteralPath $repoRoot

    # Node's fetch does not automatically use the Windows system proxy. Read the current
    # per-user proxy setting so the local Steam requests follow the same route as the browser.
    $internetSettings = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
        $proxyValue = [string]$internetSettings.ProxyServer
        if ($proxyValue -match '(?:^|;)https=([^;]+)') { $proxyValue = $Matches[1] }
        elseif ($proxyValue -match '(?:^|;)http=([^;]+)') { $proxyValue = $Matches[1] }
        if ($proxyValue -notmatch '^[a-zA-Z]+://') { $proxyValue = 'http://' + $proxyValue }
        $env:HTTPS_PROXY = $proxyValue
        $env:HTTP_PROXY = $proxyValue
    }

    $env:GITHUB_REPOSITORY = '810238492/TBH-DPS-dashboard'
    $env:VOL_BUDGET_MS = '300000'
    & node --use-env-proxy (Join-Path $repoRoot 'scripts\fetch-prices.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Steam CNY price fetch failed with exit code $LASTEXITCODE" }

    $remote = (& git -C $repoRoot remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $remote) { throw 'Could not read the GitHub origin URL.' }
    $existingDataBranch = & git ls-remote --heads $remote 'refs/heads/data'
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the GitHub data branch.' }

    if ($existingDataBranch) {
        & git clone --quiet --depth 1 --branch data --single-branch $remote $publishRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not clone the current data branch.' }
    }
    else {
        New-Item -ItemType Directory -Path $publishRoot | Out-Null
        & git -C $publishRoot init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the data branch publisher.' }
        & git -C $publishRoot checkout --quiet --orphan data
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the initial data branch.' }
        & git -C $publishRoot remote add origin $remote
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure the data branch publisher.' }
    }

    Copy-Item -LiteralPath (Join-Path $repoRoot 'prices.json') -Destination (Join-Path $publishRoot 'prices.json') -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'history.json') -Destination (Join-Path $publishRoot 'history.json') -Force
    & git -C $publishRoot add -- prices.json history.json
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the updated price feed.' }
    & git -C $publishRoot diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Output 'Price feed is unchanged; nothing to publish.'
        exit 0
    }

    & git -C $publishRoot config user.name 'TBH price updater'
    & git -C $publishRoot config user.email '810238492@users.noreply.github.com'
    & git -C $publishRoot commit --quiet -m ('CNY prices ' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
    if ($LASTEXITCODE -ne 0) { throw 'Could not commit the updated price feed.' }
    & git -C $publishRoot push --quiet --force origin 'HEAD:data'
    if ($LASTEXITCODE -ne 0) { throw 'Could not publish the updated feed to GitHub.' }
    Write-Output 'Published the CNY price feed to the GitHub data branch.'
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if (Test-Path -LiteralPath $publishRoot) {
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $publishFullPath = [IO.Path]::GetFullPath($publishRoot)
        if ($publishFullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $publishFullPath -Recurse -Force
        }
    }
    Stop-Transcript | Out-Null
}
