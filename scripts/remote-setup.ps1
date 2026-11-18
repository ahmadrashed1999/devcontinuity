# Sets up phone access through a Cloudflare Tunnel.
#   powershell -ExecutionPolicy Bypass -File scripts\remote-setup.ps1 -Hostname dc.yourdomain.com
# After this script: protect the hostname with Cloudflare Access (dashboard) and add the printed
# lines to .env.local. DevContinuity refuses remote requests without a valid Access login.
param([Parameter(Mandatory = $true)][string]$Hostname, [string]$TunnelName = 'devcontinuity', [int]$Port = 3210)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing cloudflared with winget...' -ForegroundColor Cyan
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
}
$cf = (Get-Command cloudflared).Source
$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
if (-not (Test-Path (Join-Path $cfDir 'cert.pem'))) {
  Write-Host 'A browser window opens: log in to Cloudflare and choose the zone for your hostname.' -ForegroundColor Cyan
  & $cf tunnel login
}
$existing = & $cf tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $TunnelName }
if (-not $existing) { & $cf tunnel create $TunnelName | Out-Host; $existing = & $cf tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $TunnelName } }
$id = $existing.id
& $cf tunnel route dns $TunnelName $Hostname | Out-Host

$cfg = Join-Path $cfDir 'config-devcontinuity.yml'
@"
tunnel: $id
credentials-file: $cfDir\$id.json
ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http_status:404
"@ | Set-Content -LiteralPath $cfg -Encoding ascii
Write-Host "Tunnel config written: $cfg" -ForegroundColor Green

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host "1. Cloudflare dashboard > Zero Trust > Access > Applications > Add (Self-hosted) for $Hostname."
Write-Host '   Policy: Allow > Emails > your email only. Copy the Application Audience (AUD) tag.'
Write-Host '2. Add these lines to .env.local in the DevContinuity folder:'
Write-Host '   DEVCONTINUITY_ALLOW_REMOTE=1'
Write-Host "   DEVCONTINUITY_REMOTE_HOSTS=$Hostname"
Write-Host '   CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com'
Write-Host '   CF_ACCESS_AUD=<the AUD tag>'
Write-Host '3. Restart DevContinuity from the tray icon. The tray starts the tunnel automatically.'
Write-Host "4. On your phone open https://$Hostname and use 'Add to Home Screen'."
