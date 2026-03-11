# install.ps1 — Claude Code session logger installer (Windows, personal mode only)
# Usage:
#   $env:GITHUB_PAT = "xxx"
#   $env:VAULT_PATH = "C:\Users\you\obsidian-vault"
#   .\install.ps1

param(
    [string]$Mode = "personal"
)

$ErrorActionPreference = "Stop"

function Info($msg)  { Write-Host "[✓] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[✗] $msg" -ForegroundColor Red; exit 1 }

# --- Validate ---
if ($Mode -ne "personal") { Fail "Windows installer only supports --mode=personal" }
if (-not $env:GITHUB_PAT) { Fail "GITHUB_PAT environment variable is required" }
if (-not $env:VAULT_PATH) { Fail "VAULT_PATH environment variable is required" }

# --- Check dependencies ---
$missing = @()
foreach ($cmd in @("node", "git", "jq")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        $missing += $cmd
    }
}
if ($missing.Count -gt 0) {
    Warn "Missing: $($missing -join ', ')"
    Write-Host "  Install via winget:"
    if ($missing -contains "node") { Write-Host "    winget install OpenJS.NodeJS.LTS" }
    if ($missing -contains "git")  { Write-Host "    winget install Git.Git" }
    if ($missing -contains "jq")   { Write-Host "    winget install jqlang.jq" }
    Fail "Install missing dependencies and re-run"
}

$nodeVersion = (node -e "console.log(process.versions.node.split('.')[0])").Trim()
if ([int]$nodeVersion -lt 18) { Fail "Node.js 18+ required (found v$nodeVersion)" }

Info "Dependencies OK"

# --- Setup directories ---
$hooksDir = Join-Path $env:USERPROFILE ".claude\hooks"
New-Item -ItemType Directory -Path $hooksDir -Force | Out-Null
Info "Hooks directory: $hooksDir"

# --- Download hook files ---
$repoRaw = "https://raw.githubusercontent.com/Lukasvd123/claude-logger/main"
$hookFiles = @(
    "hooks/buffer-action.sh",
    "hooks/session-end.sh",
    "hooks/session-start.sh",
    "hooks/obsidian-logger.mjs",
    "hooks/obsidian-kb-reader.mjs"
)

foreach ($f in $hookFiles) {
    $basename = Split-Path $f -Leaf
    $outPath = Join-Path $hooksDir $basename
    Invoke-WebRequest -Uri "$repoRaw/$f" -OutFile $outPath -UseBasicParsing
    Info "Downloaded $basename"
}

# --- Clone Claudelogs repo ---
$vaultExpanded = [System.Environment]::ExpandEnvironmentVariables($env:VAULT_PATH)
if (-not (Test-Path (Join-Path $vaultExpanded ".git"))) {
    $cloneUrl = "https://Lukasvd123:$($env:GITHUB_PAT)@github.com/Lukasvd123/Claudelogs.git"
    git clone $cloneUrl $vaultExpanded 2>$null
    Info "Cloned Claudelogs to $vaultExpanded"
} else {
    Info "Claudelogs already cloned at $vaultExpanded"
}

# Ensure directory structure
$dirs = @("dev-logs", "knowledge-base\tier1", "knowledge-base\tier2", "time-log", "diff-summaries")
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Path (Join-Path $vaultExpanded "claude-logs\$d") -Force | Out-Null
}

# --- PowerShell profile: env vars + cc function ---
$profilePath = $PROFILE
if (-not (Test-Path $profilePath)) {
    New-Item -ItemType File -Path $profilePath -Force | Out-Null
}

$marker = "# claude-logger"
$profileContent = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
if ($profileContent -notmatch [regex]::Escape($marker)) {
    $block = @"

$marker
`$env:GITHUB_PAT = "$($env:GITHUB_PAT)"
`$env:VAULT_PATH = "$($env:VAULT_PATH)"
`$env:CLAUDELOGS_MODE = "personal"
function cc { & node "`$env:USERPROFILE\.claude\hooks\session-start-win.mjs" @args }
"@
    Add-Content -Path $profilePath -Value $block
    Info "Added env vars + cc function to $profilePath"
} else {
    Warn "claude-logger block already in profile — skipping"
}

# --- Merge settings.json ---
$settingsFile = Join-Path $env:USERPROFILE ".claude\settings.json"
$newSettings = Invoke-WebRequest -Uri "$repoRaw/settings.json" -UseBasicParsing | Select-Object -ExpandProperty Content

if (Test-Path $settingsFile) {
    $existing = Get-Content $settingsFile -Raw
    $merged = echo "$existing" | jq --argjson new $newSettings '
        .hooks.PostToolUse = ((.hooks.PostToolUse // []) + $new.hooks.PostToolUse | unique_by(.command)) |
        .hooks.Stop = ((.hooks.Stop // []) + $new.hooks.Stop | unique_by(.command))
    '
    Set-Content -Path $settingsFile -Value $merged
    Warn "Merged hook settings into existing $settingsFile"
} else {
    Set-Content -Path $settingsFile -Value $newSettings
    Info "Created $settingsFile"
}

# --- Done ---
Write-Host ""
Info "Installation complete! (mode: personal)"
Write-Host ""
Write-Host "  Reload profile:  . `$PROFILE"
Write-Host "  Start session:   cc"
Write-Host "  Vault path:      $vaultExpanded"
Write-Host "  Hooks dir:       $hooksDir"
