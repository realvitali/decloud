# DeCloud — Windows lifecycle wrapper (PowerShell)
# Usage: .\decloud.ps1 start|stop|status|restart|qr

param([string]$Command = "status")

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

$TaskName = "DeCloud"
$Port = if ($env:DECLOUD_PORT) { $env:DECLOUD_PORT } else { "8899" }

function Get-Passcode {
    if (Test-Path ".env") {
        $line = Select-String -Path .env -Pattern '^DECLOUD_PIN=' | Select-Object -First 1
        if ($line) { return $line.Line.Substring(12) }
    }
    return "(not set — open mode)"
}

switch ($Command) {
    "start" {
        if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
            Start-ScheduledTask -TaskName $TaskName
            Write-Host "DeCloud scheduled task started."
        } else {
            Write-Host "No scheduled task found — run .\setup.ps1 first."
            Write-Host "Fallback: start the app directly in this window:"
            Write-Host "  .venv\Scripts\python.exe app.py"
        }
        Start-Sleep -Seconds 2
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 3
            Write-Host "OK App responding at http://localhost:$Port" -ForegroundColor Green
        } catch {
            Write-Host "! App not responding yet — check the task or run app.py manually." -ForegroundColor Yellow
        }
    }
    "stop" {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Get-Process python -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -like "$AppDir*"
        } | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "DeCloud stopped."
    }
    "restart" {
        & $MyInvocation.MyCommand.Path stop
        Start-Sleep -Seconds 1
        & $MyInvocation.MyCommand.Path start
    }
    "qr" {
        Write-Host "Tailscale Funnel URL (run in elevated PowerShell):"
        Write-Host "  tailscale funnel status"
        Write-Host "Passcode: $(Get-Passcode)"
    }
    default {
        Write-Host "DeCloud on Windows"
        Write-Host "  .\decloud.ps1 start    - start the app"
        Write-Host "  .\decloud.ps1 stop     - stop the app"
        Write-Host "  .\decloud.ps1 restart  - restart the app"
        Write-Host "  .\decloud.ps1 status   - show status (default)"
        Write-Host "  .\decloud.ps1 qr       - show access info"
    }
}
