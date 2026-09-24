#Requires -Version 5.1
<#
.SYNOPSIS
    ai-tabs installer for Windows.
.DESCRIPTION
    One-liner install:
      irm https://github.com/Servosity/ai-tabs/releases/latest/download/install.ps1 | iex
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║           ai-tabs installer                ║" -ForegroundColor Cyan
Write-Host "  ║   Browser tab manager for AI coding agents ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Helpers ──────────────────────────────────────────────────────────────────
function Test-CommandExists($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Confirm-Prompt($message) {
    $answer = Read-Host "$message [Y/n]"
    return ($answer -eq '' -or $answer -match '^[Yy]')
}

# ── Prerequisites ────────────────────────────────────────────────────────────
Write-Host "Checking prerequisites..." -ForegroundColor Yellow
Write-Host ""

$hasWinget = Test-CommandExists 'winget'

# Node.js
$hasNode = Test-CommandExists 'node'
$nodeOk = $false
if ($hasNode) {
    $nodeVersion = (node --version) -replace '^v', ''
    $nodeParts = $nodeVersion -split '\.'
    $nodeMajor = [int]$nodeParts[0]
    $nodeMinor = [int]$nodeParts[1]
    # Electron 41 and its build tooling need Node 22.12+
    if ($nodeMajor -gt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -ge 12)) {
        Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green
        $nodeOk = $true
    } else {
        Write-Host "  [!!] Node.js $nodeVersion found (need 22.12+)" -ForegroundColor Red
    }
} else {
    Write-Host "  [!!] Node.js not found" -ForegroundColor Red
}

if (-not $nodeOk) {
    if ($hasWinget -and (Confirm-Prompt "     Install Node.js LTS via winget?")) {
        Write-Host "     Installing Node.js LTS..." -ForegroundColor Yellow
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH so node is available in this session
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
        if (-not (Test-CommandExists 'node')) {
            Write-Host "  [!!] Node.js installed but not yet in PATH. You may need to restart your terminal." -ForegroundColor Red
            Write-Host "       Re-run this installer after restarting." -ForegroundColor Red
            exit 1
        }
        Write-Host "  [OK] Node.js installed" -ForegroundColor Green
    } else {
        Write-Host "  [!!] Node.js 18+ is required. Install from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

# Git
$hasGit = Test-CommandExists 'git'
if ($hasGit) {
    $gitVersion = (git --version) -replace 'git version ', ''
    Write-Host "  [OK] Git $gitVersion" -ForegroundColor Green
} else {
    Write-Host "  [!!] Git not found" -ForegroundColor Red
    if ($hasWinget -and (Confirm-Prompt "     Install Git for Windows via winget?")) {
        Write-Host "     Installing Git for Windows..." -ForegroundColor Yellow
        winget install Git.Git --accept-source-agreements --accept-package-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
        if (-not (Test-CommandExists 'git')) {
            Write-Host "  [!!] Git installed but not yet in PATH. Restart your terminal and re-run." -ForegroundColor Red
            exit 1
        }
        Write-Host "  [OK] Git installed" -ForegroundColor Green
    } else {
        Write-Host "  [!!] Git is required. Install from https://git-scm.com" -ForegroundColor Red
        exit 1
    }
}

# Microsoft Edge
$edgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$hasEdge = $false
foreach ($ep in $edgePaths) {
    if (Test-Path $ep) { $hasEdge = $true; break }
}
if ($hasEdge) {
    Write-Host "  [OK] Microsoft Edge" -ForegroundColor Green
} else {
    Write-Host "  [!!] Microsoft Edge not found" -ForegroundColor Red
    Write-Host "       ai-tabs uses Edge for its tabbed app window." -ForegroundColor Red
    Write-Host "       Install from: https://www.microsoft.com/edge" -ForegroundColor Red
    if (-not (Confirm-Prompt "     Continue without Edge?")) {
        exit 1
    }
}

# Claude Code (optional)
$hasClaude = Test-CommandExists 'claude'
if ($hasClaude) {
    Write-Host "  [OK] Claude Code" -ForegroundColor Green
} else {
    Write-Host "  [--] Claude Code not found (optional)" -ForegroundColor DarkYellow
    Write-Host "       Install later: npm install -g @anthropic-ai/claude-code" -ForegroundColor DarkYellow
}

Write-Host ""

# ── Install / Update ─────────────────────────────────────────────────────────
$installDir = Join-Path $env:LOCALAPPDATA 'ai-tabs'
$installDirIsFresh = -not (Test-Path $installDir)

# Kill running ai-tabs so file locks don't block npm install
$ccProcs = Get-Process -Name 'ai-tabs', 'electron' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "$installDir*" }
if ($ccProcs) {
    Write-Host "  Stopping running ai-tabs..." -ForegroundColor Yellow
    $ccProcs | Stop-Process -Force
    Start-Sleep -Seconds 1
    Write-Host "  [OK] Stopped" -ForegroundColor Green
}

if (Test-Path (Join-Path $installDir '.git')) {
    Write-Host "Updating existing installation..." -ForegroundColor Yellow
    Push-Location $installDir
    try {
        git pull --ff-only
    } catch {
        Write-Host "  git pull failed, trying fresh clone..." -ForegroundColor DarkYellow
        Pop-Location
        Remove-Item $installDir -Recurse -Force
        git clone https://github.com/Servosity/ai-tabs.git $installDir
    }
    Pop-Location
} else {
    if (Test-Path $installDir) {
        Remove-Item $installDir -Recurse -Force
    }
    Write-Host "Cloning ai-tabs..." -ForegroundColor Yellow
    git clone https://github.com/Servosity/ai-tabs.git $installDir
}

# One-time migration: if this run started with no existing ai-tabs install and
# a legacy cc-tabs install exists, adopt its settings data so the user doesn't
# lose favorites, projects, or theme settings when switching to the new
# install directory. Runs after the clone/update above so the freshly checked
# out install dir isn't wiped out afterward.
if ($installDirIsFresh) {
    $legacyInstallDir = Join-Path $env:LOCALAPPDATA 'cc-tabs'
    $legacyDataDir = Join-Path $legacyInstallDir 'data'
    if (Test-Path $legacyDataDir) {
        $newDataDir = Join-Path $installDir 'data'
        New-Item -ItemType Directory -Force -Path $newDataDir | Out-Null
        $migratedAny = $false
        Get-ChildItem -Path $legacyDataDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
            $destFile = Join-Path $newDataDir $_.Name
            if (-not (Test-Path $destFile)) {
                Copy-Item $_.FullName $destFile
                $migratedAny = $true
            }
        }
        if ($migratedAny) {
            Write-Host "  [OK] Migrated settings from legacy cc-tabs install" -ForegroundColor Green
        }
    }
}

Write-Host "Installing dependencies (this may take a minute)..." -ForegroundColor Yellow
Push-Location $installDir
npm install --no-fund --no-audit 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [!!] npm install failed. Check errors above." -ForegroundColor Red
        Pop-Location
        exit 1
    }
}
Pop-Location
Write-Host "  [OK] Dependencies installed" -ForegroundColor Green
Write-Host ""

# ── Shortcuts ────────────────────────────────────────────────────────────────
Write-Host "Creating shortcuts..." -ForegroundColor Yellow

$cmdPath = Join-Path $installDir 'ai-tabs.cmd'
$icoPath = Join-Path $installDir 'ai-tabs.ico'
$shell = New-Object -ComObject WScript.Shell

# Desktop shortcut
$desktopPath = [Environment]::GetFolderPath('Desktop')
$lnk = $shell.CreateShortcut("$desktopPath\ai-tabs.lnk")
$lnk.TargetPath = $cmdPath
$lnk.IconLocation = $icoPath
$lnk.WorkingDirectory = $installDir
$lnk.Description = "ai-tabs - AI Agent Terminal Manager"
$lnk.WindowStyle = 7  # minimized
$lnk.Save()
Write-Host "  [OK] Desktop shortcut" -ForegroundColor Green

# Start Menu shortcut
$startMenuPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk2 = $shell.CreateShortcut("$startMenuPath\ai-tabs.lnk")
$lnk2.TargetPath = $cmdPath
$lnk2.IconLocation = $icoPath
$lnk2.WorkingDirectory = $installDir
$lnk2.Description = "ai-tabs - AI Agent Terminal Manager"
$lnk2.WindowStyle = 7
$lnk2.Save()
Write-Host "  [OK] Start Menu shortcut" -ForegroundColor Green

# Startup (optional)
Write-Host ""
if (Confirm-Prompt "Start ai-tabs on login?") {
    $startupPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    $lnk3 = $shell.CreateShortcut("$startupPath\ai-tabs.lnk")
    $lnk3.TargetPath = $cmdPath
    $lnk3.IconLocation = $icoPath
    $lnk3.WorkingDirectory = $installDir
    $lnk3.Description = "ai-tabs - AI Agent Terminal Manager"
    $lnk3.WindowStyle = 7
    $lnk3.Save()
    Write-Host "  [OK] Startup shortcut" -ForegroundColor Green
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║         Installation complete!             ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Installed to: $installDir" -ForegroundColor White
Write-Host ""
Write-Host "  Configuration:" -ForegroundColor Yellow
Write-Host "    Set PROJECTS_ROOT if your projects aren't in ~/Documents/Projects:" -ForegroundColor White
Write-Host '    [System.Environment]::SetEnvironmentVariable("PROJECTS_ROOT", "C:\your\path", "User")' -ForegroundColor DarkGray
Write-Host ""
Write-Host "  PWA tip:" -ForegroundColor Yellow
Write-Host "    Open http://localhost:25283 in Edge, click '...' > 'Install as App'" -ForegroundColor White
Write-Host "    for a native-feeling tabbed window." -ForegroundColor White
Write-Host ""

# Launch now?
if (Confirm-Prompt "Launch ai-tabs now?") {
    Start-Process -FilePath $cmdPath -WorkingDirectory $installDir
    Write-Host ""
    Write-Host "  ai-tabs is starting at http://localhost:25283" -ForegroundColor Cyan
}

Write-Host ""
