# Usage: npm run release -- 0.2.0
# Sets the version everywhere, commits, tags v<version> and pushes.
# GitHub Actions then builds and publishes the release.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式：0.2.0" }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM: Cargo / Tauri read these

function Set-Version($path, $pattern, $replacement) {
    $text = [System.IO.File]::ReadAllText($path, $utf8)
    $re = New-Object System.Text.RegularExpressions.Regex($pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    $new = $re.Replace($text, $replacement, 1)
    [System.IO.File]::WriteAllText($path, $new, $utf8)
}

Set-Version (Join-Path $root "src-tauri\tauri.conf.json") '"version":\s*"[^"]+"' ('"version": "' + $Version + '"')
Set-Version (Join-Path $root "package.json") '"version":\s*"[^"]+"' ('"version": "' + $Version + '"')
Set-Version (Join-Path $root "src-tauri\Cargo.toml") '^version\s*=\s*"[^"]+"' ('version = "' + $Version + '"')

git add -A
git commit -m "v$Version"
git tag "v$Version"
git push
git push origin "v$Version"
Write-Host "已推送 v$Version，去 GitHub 仓库的 Actions 页面看打包进度（大约 15 分钟）。"
