# Adds or removes the "start DevContinuity with Windows" shortcut (your Startup folder only).
#   powershell -ExecutionPolicy Bypass -File scripts\startup.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File scripts\startup.ps1 -Remove
param([switch]$Install, [switch]$Remove)

$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'DevContinuity.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk; Write-Host "Removed $lnk" } else { Write-Host 'Not installed.' }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = (Get-Command powershell.exe).Source
$s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\tray.ps1`""
$s.WorkingDirectory = $root
$s.WindowStyle = 7
$s.Description = 'DevContinuity tray (web UI, auto-sync, AI organization)'
$s.Save()
Write-Host "Installed: DevContinuity will start with Windows ($lnk)."
if ($Install) {
  Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\tray.ps1`"" -WindowStyle Hidden
  Write-Host 'Tray started. Look for the DevContinuity icon near the clock.'
}
