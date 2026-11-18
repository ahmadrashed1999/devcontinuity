# DevContinuity tray app.
# Keeps the web UI (port 3210) and the background orchestrator running, shows notifications as
# Windows balloons, and offers Open / Pause all agents (kill switch) / Restart / Quit.
# Uses only built-in Windows components (no extra install).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$mutex = New-Object System.Threading.Mutex($false, 'Global\DevContinuityTray')
if (-not $mutex.WaitOne(0)) { exit 0 }  # already running

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$port = 3210
$base = "http://localhost:$port"
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { [System.Windows.Forms.MessageBox]::Show('Node.js was not found on PATH. Install Node.js 22+ and try again.', 'DevContinuity') | Out-Null; exit 1 }

$script:web = $null
$script:orch = $null
$script:tunnel = $null
$script:lastNotif = -1

function Test-Port {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { return $false }
}

function Get-Token { $f = Join-Path $root 'data\.api-token'; if (Test-Path $f) { (Get-Content -Raw $f).Trim() } else { $null } }

function Invoke-Api([string]$method, [string]$path, $body) {
  $t = Get-Token; if (-not $t) { return $null }
  $h = @{ Authorization = "Bearer $t" }
  try {
    if ($body) { return Invoke-RestMethod -Method $method -Uri "$base/api/$path" -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 10 }
    return Invoke-RestMethod -Method $method -Uri "$base/api/$path" -Headers $h -TimeoutSec 10
  } catch { return $null }
}

function Start-Web {
  if (Test-Port) { return }
  if (-not (Test-Path (Join-Path $root '.next\BUILD_ID'))) {
    $icon.ShowBalloonTip(5000, 'DevContinuity', 'Building the app for the first time (a few minutes)...', 'Info')
    Start-Process -FilePath $node -ArgumentList @('node_modules\next\dist\bin\next', 'build') -WorkingDirectory $root -WindowStyle Hidden -Wait -RedirectStandardOutput (Join-Path $logs 'build.log') -RedirectStandardError (Join-Path $logs 'build.err.log')
  }
  $script:web = Start-Process -FilePath $node -ArgumentList @('node_modules\next\dist\bin\next', 'start', '-p', "$port") -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web.err.log')
}

function Start-Orchestrator {
  if ($script:orch -and -not $script:orch.HasExited) { return }
  $script:orch = Start-Process -FilePath $node -ArgumentList @('node_modules\tsx\dist\cli.mjs', 'scripts\orchestrator.ts') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'orchestrator.out.log') -RedirectStandardError (Join-Path $logs 'orchestrator.err.log')
}

function Start-Tunnel {
  $cfg = Join-Path $env:USERPROFILE '.cloudflared\config-devcontinuity.yml'
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if ($cf -and (Test-Path $cfg) -and (-not $script:tunnel -or $script:tunnel.HasExited)) {
    $script:tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--config', $cfg, 'run') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'tunnel.log') -RedirectStandardError (Join-Path $logs 'tunnel.err.log')
  }
}

function Stop-All {
  foreach ($p in @($script:web, $script:orch, $script:tunnel)) {
    if ($p -and -not $p.HasExited) { try { & taskkill.exe /PID $p.Id /T /F | Out-Null } catch {} }
  }
}

# --- tray icon (drawn, no image file needed) ---
$bmp = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 32, 32), [System.Drawing.Color]::FromArgb(99, 102, 241), [System.Drawing.Color]::FromArgb(6, 182, 212))
$g.FillEllipse($brush, 1, 1, 30, 30)
$g.FillRectangle([System.Drawing.Brushes]::White, 9, 10, 14, 3)
$g.FillRectangle([System.Drawing.Brushes]::White, 9, 15, 14, 3)
$g.FillRectangle([System.Drawing.Brushes]::White, 9, 20, 9, 3)
$g.Dispose()

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$icon.Text = 'DevContinuity'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miDash = $menu.Items.Add('Open DevContinuity')
$miAgents = $menu.Items.Add('Connected agents')
$miAsk = $menu.Items.Add('Ask my projects')
[void]$menu.Items.Add('-')
$miKill = $menu.Items.Add('Pause all AI agents (kill switch)')
$miRestart = $menu.Items.Add('Restart services')
$miLogs = $menu.Items.Add('Open logs folder')
[void]$menu.Items.Add('-')
$miQuit = $menu.Items.Add('Quit DevContinuity')
$icon.ContextMenuStrip = $menu

$miAgents.add_Click({ Start-Process "$base/agents" })
$miDash.add_Click({ Start-Process "$base/" })
$miAsk.add_Click({ Start-Process "$base/ask" })
$icon.add_DoubleClick({ Start-Process "$base/" })
$miLogs.add_Click({ Start-Process explorer.exe $logs })
$miKill.add_Click({
  $state = Invoke-Api 'GET' 'killswitch' $null
  $on = -not ($state -and $state.on)
  $r = Invoke-Api 'PUT' 'killswitch' @{ on = $on }
  if ($r) { $icon.ShowBalloonTip(4000, 'DevContinuity', $(if ($on) { 'All AI agents stopped.' } else { 'AI agents resumed.' }), 'Info') }
})
$miRestart.add_Click({ Stop-All; Start-Sleep 2; Start-Web; Start-Orchestrator; Start-Tunnel; $icon.ShowBalloonTip(3000, 'DevContinuity', 'Services restarted.', 'Info') })
$miQuit.add_Click({ Stop-All; $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::Exit() })

Start-Web
Start-Orchestrator
Start-Tunnel
$icon.ShowBalloonTip(4000, 'DevContinuity', "Running at $base. Logging every connected agent.", 'Info')

# --- watchdog + notifications ---
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({
  if (-not (Test-Port)) { Start-Web }
  if (-not $script:orch -or $script:orch.HasExited) { Start-Orchestrator }
  $state = Invoke-Api 'GET' 'killswitch' $null
  if ($state) { $miKill.Text = $(if ($state.on) { 'Resume AI agents (kill switch is ON)' } else { 'Pause all AI agents (kill switch)' }) }
  $n = Invoke-Api 'GET' 'notifications?unread=1' $null
  if ($n -and $n.rows) {
    $newest = ($n.rows | Measure-Object -Property id -Maximum).Maximum
    if ($script:lastNotif -lt 0) { $script:lastNotif = $newest }
    else {
      $fresh = @($n.rows | Where-Object { $_.id -gt $script:lastNotif } | Sort-Object id)
      foreach ($x in ($fresh | Select-Object -Last 3)) {
        $lvl = if ($x.level -eq 'error') { 'Error' } elseif ($x.level -eq 'warning') { 'Warning' } else { 'Info' }
        $body = if ($x.body) { $x.body } else { ' ' }
        $icon.ShowBalloonTip(6000, $x.title, $body.Substring(0, [Math]::Min(200, $body.Length)), $lvl)
      }
      if ($fresh.Count) { $script:lastNotif = $newest }
    }
  }
})
$timer.Start()
$icon.add_BalloonTipClicked({ Start-Process "$base/" })

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
