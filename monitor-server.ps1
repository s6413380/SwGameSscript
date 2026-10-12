# Multi-account monitor relay for auto-clicker-v2.user.js
# Each game tab POSTs its status to /status?id=<accountId>; open http://localhost:8787/ to see all accounts.
# Usage: powershell -ExecutionPolicy Bypass -File .\monitor-server.ps1
param([int]$Port = 8787, [int]$StaleMinutes = 10)

$ErrorActionPreference = 'Stop'
$dashboardPath = Join-Path $PSScriptRoot 'monitor-dashboard.html'
$growthDir = Join-Path $PSScriptRoot 'growth-data'
# The loader is installed once per browser profile and pulls the main script from here on every page load
$userScripts = @{
  '/auto-clicker-v2.user.js' = (Join-Path $PSScriptRoot 'auto-clicker-v2.user.js')
  '/auto-clicker-v2.loader.user.js' = (Join-Path $PSScriptRoot 'auto-clicker-v2.loader.user.js')
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
# Raw JSON per account, kept as text so Chinese and numbers pass through untouched
$accounts = @{}
# Commands from the dashboard wait here until that tab's next status report picks them up
$commands = @{}

function Now-Milliseconds {
  [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Send-Response($response, [int]$status, [string]$contentType, [string]$body) {
  $bytes = $utf8.GetBytes($body)
  $response.StatusCode = $status
  $response.ContentType = $contentType
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Handle-Request($context) {
  $request = $context.Request
  $response = $context.Response
  # The game page is https on another origin; Chrome also asks for the private-network header before letting it reach localhost
  $response.Headers.Add('Access-Control-Allow-Origin', '*')
  $response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  $response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
  $response.Headers.Add('Access-Control-Allow-Private-Network', 'true')
  $path = $request.Url.AbsolutePath

  if ($request.HttpMethod -eq 'OPTIONS') {
    Send-Response $response 204 'text/plain' ''
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/status') {
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    $id = $request.QueryString['id']
    if ($id -notmatch '^[\w-]{1,40}$' -or $raw.Length -gt 200000) {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    # Reject broken JSON here so one bad report cannot break the dashboard
    try { $null = $raw | ConvertFrom-Json } catch {
      Send-Response $response 400 'text/plain' 'invalid json'
      return
    }
    $accounts[$id] = @{ at = (Now-Milliseconds); raw = $raw }
    $pending = @()
    if ($commands.ContainsKey($id)) {
      $pending = $commands[$id].ToArray()
      $commands.Remove($id)
      Write-Host "$(Get-Date -Format HH:mm:ss) delivered $($pending.Count) command(s) to account $id"
    }
    Send-Response $response 200 'application/json; charset=utf-8' ('{"commands":[' + ($pending -join ',') + ']}')
    return
  }
  # Growth records: each account uploads only its own heroes; tabs download all files and merge them locally.
  # Kept as files so restarting the relay loses nothing
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/growth') {
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    $id = $request.QueryString['id']
    # ConvertFrom-Json in PowerShell 5.1 rejects anything over 2 MB, so only check the header here; tabs validate on import
    if ($id -notmatch '^\d{1,20}$' -or $raw.Length -gt 20000000 -or -not $raw.StartsWith('{"format":"swordgale-growth"')) {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    if (-not (Test-Path $growthDir)) { $null = New-Item -ItemType Directory $growthDir }
    [System.IO.File]::WriteAllText((Join-Path $growthDir "$id.json"), $raw, $utf8)
    Write-Host "$(Get-Date -Format HH:mm:ss) growth records saved for account $id ($($raw.Length) chars)"
    Send-Response $response 200 'text/plain' 'ok'
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/growth') {
    $sources = @()
    if (Test-Path $growthDir) {
      $sources = foreach ($file in (Get-ChildItem $growthDir -Filter '*.json')) { [System.IO.File]::ReadAllText($file.FullName, $utf8) }
    }
    Send-Response $response 200 'application/json; charset=utf-8' ('{"sources":[' + (@($sources) -join ',') + ']}')
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/bye') {
    # Sent when a tab closes or turns reporting off, so its card disappears instead of showing offline
    $id = $request.QueryString['id']
    if ($id) {
      $accounts.Remove($id)
      $commands.Remove($id)
      Write-Host "$(Get-Date -Format HH:mm:ss) tab $id left"
    }
    Send-Response $response 200 'text/plain' 'ok'
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/command') {
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    $id = $request.QueryString['id']
    if ($id -notmatch '^[\w-]{1,40}$' -or $raw.Length -gt 10000) {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    try { $null = $raw | ConvertFrom-Json } catch {
      Send-Response $response 400 'text/plain' 'invalid json'
      return
    }
    if (-not $commands.ContainsKey($id)) { $commands[$id] = New-Object System.Collections.ArrayList }
    $null = $commands[$id].Add($raw)
    Write-Host "$(Get-Date -Format HH:mm:ss) queued for account ${id}: $raw"
    Send-Response $response 200 'text/plain' 'ok'
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/status') {
    # Each browser tab reports under its own id; a closed tab would otherwise stay on the dashboard forever
    $staleBefore = (Now-Milliseconds) - $StaleMinutes * 60000
    foreach ($id in @($accounts.Keys)) {
      if ($accounts[$id].at -lt $staleBefore) {
        $accounts.Remove($id)
        $commands.Remove($id)
      }
    }
    $items = foreach ($id in ($accounts.Keys | Sort-Object)) {
      $pendingCount = 0
      if ($commands.ContainsKey($id)) { $pendingCount = $commands[$id].Count }
      '{"id":"' + $id + '","at":' + $accounts[$id].at + ',"pending":' + $pendingCount + ',"data":' + $accounts[$id].raw + '}'
    }
    $body = '{"now":' + (Now-Milliseconds) + ',"accounts":[' + ($items -join ',') + ']}'
    Send-Response $response 200 'application/json; charset=utf-8' $body
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/') {
    $html = [System.IO.File]::ReadAllText($dashboardPath, $utf8)
    Send-Response $response 200 'text/html; charset=utf-8' $html
    return
  }
  # Tampermonkey in every browser profile installs and updates the userscript from here, so one edit reaches all of them
  # Tabs poll this to notice a new version without downloading the whole script
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/version') {
    $script = [System.IO.File]::ReadAllText($userScripts['/auto-clicker-v2.user.js'], $utf8)
    $match = [regex]::Match($script, '@version\s+(\S+)')
    Send-Response $response 200 'text/plain; charset=utf-8' $match.Groups[1].Value
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $userScripts.ContainsKey($path)) {
    $script = [System.IO.File]::ReadAllText($userScripts[$path], $utf8)
    Send-Response $response 200 'text/javascript; charset=utf-8' $script
    return
  }
  Send-Response $response 404 'text/plain' 'not found'
}

$listener = New-Object System.Net.HttpListener
# localhost only: other machines on the network cannot read or post
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Monitor running: http://localhost:$Port/  (Ctrl+C to stop)"
try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    # Wait in short slices so Ctrl+C can stop the script
    while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
    try {
      Handle-Request $task.Result
    } catch {
      Write-Host "Request failed: $($_.Exception.Message)"
      try { $task.Result.Response.Abort() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
