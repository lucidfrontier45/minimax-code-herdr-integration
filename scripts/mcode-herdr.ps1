<#
.SYNOPSIS
    Launch MiniMax Code and tell Herdr about it immediately (Windows).

.DESCRIPTION
    Windows counterpart of the bash `mcode-herdr` wrapper.

    MiniMax Code creates its session lazily: no plugin hook fires until the
    first prompt is submitted, so a plugin alone can only report "an agent is
    here" after the user already typed something. This script runs before mcode
    starts, in the pane's shell, where HERDR_PANE_ID and HERDR_BIN_PATH are
    available, and reports the agent as idle right away.

    The herdr-integration plugin takes over from there and adds the session id
    and the resume command as soon as the session exists.

.EXAMPLE
    mcode-herdr
    mcode-herdr --session <id>
    mcode-herdr --report-only
#>

$ErrorActionPreference = "SilentlyContinue"

$HerdrBin = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { "herdr" }
$Source = "mcode"
$Agent = "mcode"

# Shared with the plugin so that sequence numbers never go backwards.
$StateDir = Join-Path $env:USERPROFILE ".minimax\v2\plugin-data\hooks\herdr-integration"

function Get-NextSeq {
    $file = Join-Path $StateDir "seq"
    $last = 0
    if (Test-Path $file) {
        $parsed = 0
        if ([int]::TryParse((Get-Content $file -Raw).Trim(), [ref]$parsed)) { $last = $parsed }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $seq = if ($now -gt $last) { $now } else { $last + 1 }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Set-Content -Path $file -Value $seq -NoNewline
    return $seq
}

# Non-interactive subcommands must not create a phantom agent in the pane.
$interactive = $true
$reportOnly = $false
$sessionId = ""
$expectSession = $false

foreach ($arg in $args) {
    if ($arg -eq "--report-only") {
        $reportOnly = $true
    }
    elseif ($arg -in @("exec", "acp", "app-server", "plugin", "login", "logout", "update", "provider", "tools")) {
        $interactive = $false
    }
    elseif ($arg -in @("-v", "--version", "-h", "--help")) {
        $interactive = $false
    }
    elseif ($expectSession) {
        $sessionId = $arg
        $expectSession = $false
    }
    elseif ($arg -eq "--session") {
        $expectSession = $true
    }
}

function Invoke-Report {
    if (-not $env:HERDR_PANE_ID) { return }
    $herdrArgs = @(
        "pane", "report-agent", $env:HERDR_PANE_ID,
        "--source", $Source,
        "--agent", $Agent,
        "--state", "idle",
        "--seq", (Get-NextSeq)
    )
    if ($sessionId) {
        $herdrArgs += @("--agent-session-id", $sessionId, "--", "mcode", "--session", $sessionId)
    }
    & $HerdrBin @herdrArgs | Out-Null
}

if ($interactive) { Invoke-Report }

if ($reportOnly) { exit 0 }

& mcode @args
exit $LASTEXITCODE
