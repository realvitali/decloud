# DeCloud — Windows installer
# Usage (PowerShell, run as the user who will own the service):
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Creates a virtual environment, installs dependencies, generates a
# locked-down .env (8-digit passcode), and registers a logon scheduled
# task so DeCloud starts with your session.

$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "   DeCloud - Windows Installer" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# ─── 1. Locate Python ─────────────────────────────────────────
$Python = $null
foreach ($candidate in @('py', 'python', 'python3')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $Python = $candidate
        break
    }
}
if (-not $Python) {
    Write-Host "X Python 3.10+ is required." -ForegroundColor Red
    Write-Host "  Install it from the Microsoft Store ('Python 3.12') or python.org,"
    Write-Host "  then run this script again."
    exit 1
}

$Version = & $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
Write-Host "OK Python $Version found" -ForegroundColor Green
if ([version]$Version -lt [version]"3.10") {
    Write-Host "X Python 3.10+ required, found $Version" -ForegroundColor Red
    exit 1
}

# ─── 2. Virtual environment ───────────────────────────────────
if (-not (Test-Path ".venv")) {
    Write-Host "-> Creating virtual environment..."
    & $Python -m venv .venv
}
$VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Host "X venv python not found at $VenvPython" -ForegroundColor Red
    exit 1
}

Write-Host "-> Installing dependencies..."
& $VenvPython -m pip install --upgrade pip | Out-Null
& $VenvPython -m pip install -r requirements.txt

# ─── 3. .env with generated secrets ───────────────────────────
if (-not (Test-Path ".env")) {
    Write-Host "-> Creating .env from template..."
    Copy-Item .env.example .env
    $Secret = & $VenvPython -c "import secrets; print(secrets.token_hex(32))"
    $Passcode = & $VenvPython -c "import secrets; print(''.join(str(secrets.randbelow(10)) for _ in range(8)))"
    (Get-Content .env -Raw) `
        -replace 'change-me-to-a-random-string', $Secret `
        -replace '^DECLOUD_PIN=.*$', "DECLOUD_PIN=$Passcode" | Set-Content .env -NoNewline
    Write-Host "OK .env created" -ForegroundColor Green
}

# ─── 4. Lock .env down to the current user only ────────────────
Write-Host "-> Locking down .env permissions..."
icacls "$AppDir\.env" /inheritance:r /grant:r "$env:USERNAME`:F" | Out-Null

# ─── 5. Scheduled task (starts with logon) ─────────────────────
$TaskName = "DeCloud"
$Action = New-ScheduledTaskAction -Execute $VenvPython `
    -Argument "`"$AppDir\app.py`"" `
    -WorkingDirectory $AppDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "OK Scheduled task '$TaskName' registered (starts at logon)" -ForegroundColor Green

# ─── 6. Start now ──────────────────────────────────────────────
Write-Host "-> Starting DeCloud..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "DeCloud is running at http://localhost:8899" -ForegroundColor Green
Write-Host "Access passcode: $Passcode" -ForegroundColor Yellow
Write-Host ""
Write-Host "Remote access (optional):" -ForegroundColor Cyan
Write-Host "  1. Install Tailscale: https://tailscale.com/download/windows"
Write-Host "  2. In an elevated PowerShell: tailscale up"
Write-Host "  3. Enable Funnel: tailscale funnel 8899"
Write-Host "     (Funnel gives a public https://...ts.net URL; the passcode"
Write-Host "      still protects everything behind it.)"
Write-Host ""
Write-Host "Management: .\decloud.ps1 start|stop|status|restart" -ForegroundColor Cyan
