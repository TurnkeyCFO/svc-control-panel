# Checks /health and restarts run.bat if unhealthy. Caps restart loop via kill-switch file.
# Self-hide this console window immediately (no-admin fix for the every-2-min pop-up; task action can't be changed without elevation).
Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);' -ErrorAction SilentlyContinue
try { [Native.Win]::ShowWindow([Native.Win]::GetConsoleWindow(), 0) | Out-Null } catch {}
$ErrorActionPreference = "SilentlyContinue"

$repoRoot  = Split-Path -Parent $PSScriptRoot
$runBat    = Join-Path $repoRoot "scripts\run.bat"
$dataDir   = Join-Path $env:LOCALAPPDATA "turnkey-cp"
$killFile  = Join-Path $dataDir "kill-switch"
$histFile  = Join-Path $dataDir "watchdog.history"

if (Test-Path $killFile) { exit 0 }

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:7823/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

# Unhealthy — check recent restart history to avoid hot loop
$now = [int][double]::Parse((Get-Date -UFormat %s))
$cutoff = $now - 3600
$recent = @()
if (Test-Path $histFile) {
    $recent = Get-Content $histFile | Where-Object { [int]$_ -gt $cutoff }
}
if ($recent.Count -ge 3) {
    # Third restart in an hour - post to Slack if token present, then stop
    try {
        $envFile = Join-Path (Split-Path -Parent $repoRoot) ".env"
        if (Test-Path $envFile) {
            $token   = (Get-Content $envFile | Where-Object { $_ -match "^SLACK_BOT_TOKEN=" } | Select-Object -First 1) -replace "^SLACK_BOT_TOKEN=",""
            $channel = (Get-Content $envFile | Where-Object { $_ -match "^SLACK_CHANNEL_ASSISTANTBOT=" } | Select-Object -First 1) -replace "^SLACK_CHANNEL_ASSISTANTBOT=",""
            if ($token -and $channel) {
                $body = @{ channel = $channel; text = "Control panel watchdog: >=3 restarts in last hour. Stopped auto-restart. Check %LOCALAPPDATA%\turnkey-cp\stderr.log" } | ConvertTo-Json -Compress
                Invoke-RestMethod -Uri "https://slack.com/api/chat.postMessage" -Method Post -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json; charset=utf-8" } -Body $body | Out-Null
            }
        }
    } catch { }
    New-Item -ItemType File -Path $killFile -Force | Out-Null
    exit 1
}

Add-Content -Path $histFile -Value "$now"
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c `"$runBat`""
