# Puts ffmpeg.exe into src-tauri\bin so the installer can ship it.
# Order: already there -> the one on PATH -> download a build with ddagrab + NVENC.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "src-tauri\bin"
$dest = Join-Path $bin "ffmpeg.exe"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

function Test-Ffmpeg($exe) {
    try {
        $filters = & $exe -hide_banner -filters 2>$null | Out-String
        $encoders = & $exe -hide_banner -encoders 2>$null | Out-String
        return ($filters -match "ddagrab") -and ($encoders -match "h264_nvenc")
    } catch { return $false }
}

if ((Test-Path $dest) -and (Test-Ffmpeg $dest)) {
    Write-Host "ffmpeg 已就绪：$dest"
    exit 0
}

# on GitHub Actions always use the pinned download, never whatever the runner has
$onPath = if ($env:CI -eq "true") { $null } else { Get-Command ffmpeg -ErrorAction SilentlyContinue }
if ($onPath -and (Test-Ffmpeg $onPath.Source)) {
    Copy-Item $onPath.Source $dest -Force
    # a package-manager shim does not work on its own once copied
    if (Test-Ffmpeg $dest) {
        Write-Host "已复制 PATH 里的 ffmpeg：$($onPath.Source)"
        exit 0
    }
}

# a released version, not "master": master changes options under us
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
$zip = Join-Path $env:TEMP "killcam-ffmpeg.zip"
$tmp = Join-Path $env:TEMP "killcam-ffmpeg"
Write-Host "下载 ffmpeg：$url"
Invoke-WebRequest -Uri $url -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp
$exe = Get-ChildItem -Path $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if (-not $exe) { throw "压缩包里没有 ffmpeg.exe" }
Copy-Item $exe.FullName $dest -Force
Remove-Item $zip -Force
Remove-Item $tmp -Recurse -Force
if (-not (Test-Ffmpeg $dest)) { throw "下载的 ffmpeg 没有 ddagrab / h264_nvenc" }
Write-Host "ffmpeg 已就绪：$dest"
