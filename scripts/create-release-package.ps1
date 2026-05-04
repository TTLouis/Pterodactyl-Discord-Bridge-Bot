$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $repoRoot "dist"
$output = Join-Path $distDir "discord-pterodactyl-bridge.zip"

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path $output) {
    Remove-Item $output
}

git -C $repoRoot archive --format=zip --output=$output HEAD

Write-Host "Created $output"
