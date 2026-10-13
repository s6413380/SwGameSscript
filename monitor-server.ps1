# Multi-account monitor relay for auto-clicker-v2.user.js
# Each game tab POSTs its status to /status?id=<accountId>; open http://localhost:8787/ to see all accounts.
# Usage: powershell -ExecutionPolicy Bypass -File .\monitor-server.ps1
param([int]$Port = 8787, [int]$StaleMinutes = 10, [int]$TurnSwitchMinMs = 500, [int]$TurnSwitchMaxMs = 1500, [int]$TransferSwitchMinMs = 600, [int]$TransferSwitchMaxMs = 1500)

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
# Turn taking: all accounts share one computer, so only one tab may call the game API at a time,
# and handing the turn to another tab waits a moment like a person switching windows
$turn = @{ holder = ''; until = 0; lastHolder = ''; freeAt = 0; switchGap = 0; streak = 0; pick = '' }
# Tabs waiting for the turn; see Pick-Waiter for who goes next
$turnWaiters = @{}
# How many times each tab was passed over in a row, and recent grants (last 10 minutes) for fair shares
$turnSkips = @{}
$turnGrants = New-Object System.Collections.ArrayList
# Settings that must match on every account (low profile, turn taking); the newest copy wins
$sharedSettings = '{}'
# Pause for every account at once (buttons on each panel and the dashboard): run, temp (until a time) or stop.
# Saved to a file so a permanent pause is still there after the relay restarts
$globalPausePath = Join-Path $PSScriptRoot 'global-pause.json'
$globalPause = @{ mode = 'run'; until = 0 }
if (Test-Path $globalPausePath) {
  try {
    $saved = Get-Content -Raw $globalPausePath | ConvertFrom-Json
    $globalPause.mode = [string]$saved.mode
    $globalPause.until = [long]$saved.until
  } catch { }
}

function Global-PauseJson {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($globalPause.mode -eq 'temp' -and $globalPause.until -le $now) { $globalPause.mode = 'run' }
  return '{"mode":"' + $globalPause.mode + '","until":' + $globalPause.until + ',"now":' + $now + '}'
}
# Longer than the script's 30 s game request timeout; a crashed tab loses the turn after this
$turnLeaseMs = 40000
# While two local accounts transfer through the market, only their requests get the turn, so the listing
# is bought quickly; mode 'human' still waits a little between the two windows, 'fast' does not
$transfer = @{ ids = @{}; mode = 'human'; until = 0 }

# Dashboard 'go to this account': each game tab ends its title with an invisible account id marker,
# so the relay can find that browser window and bring it to the front
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowFocus {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

  // Windows only lets the foreground app hand focus to another window; a quick Alt press lifts that lock
  public static string Focus(string marker) {
    var found = new List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var text = new StringBuilder(512);
      GetWindowText(hWnd, text, text.Capacity);
      if (text.ToString().Contains(marker)) found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    if (found.Count == 0) return "notfound";
    IntPtr target = found[0];
    if (IsIconic(target)) ShowWindow(target, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(target);
    return GetForegroundWindow() == target ? "ok" : "blocked";
  }
}
'@

function Now-Milliseconds {
  [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Transfer-Active([long]$now) {
  if ($transfer.ids.Count -gt 0 -and $transfer.until -lt $now) { $transfer.ids.Clear() }
  return $transfer.ids.Count -gt 0
}

function New-SwitchGap([long]$now) {
  if (Transfer-Active $now) {
    if ($transfer.mode -eq 'fast') { return 0 }
    return Get-Random -Minimum $TransferSwitchMinMs -Maximum ($TransferSwitchMaxMs + 1)
  }
  return Get-Random -Minimum $TurnSwitchMinMs -Maximum ($TurnSwitchMaxMs + 1)
}

function Release-Turn([long]$now) {
  $turn.lastHolder = $turn.holder
  $turn.holder = ''
  $turn.freeAt = $now
  $turn.switchGap = New-SwitchGap $now
}

function Grant-Turn([string]$id, [long]$now) {
  $turnWaiters.Remove($id)
  $turn.holder = $id
  $turn.until = $now + $turnLeaseMs
}

# A strict A-B-C rotation is easy to spot, so the next tab is a weighted random pick: waiting longer and
# having had fewer turns lately raise the odds, and the tab that just went is unlikely (but possible) to go again.
# Guarantees: a tab passed over twice, or waiting over 12 s, is served next.
function Pick-Waiter([long]$now) {
  $waiters = @($turnWaiters.Keys | Where-Object { -not $turnWaiters[$_].transfer })
  if ($waiters.Count -eq 0) { return '' }
  $forced = @($waiters | Where-Object { [int]$turnSkips[$_] -ge 2 -or $now - $turnWaiters[$_].since -gt 12000 })
  if ($forced.Count -gt 0) { return ($forced | Sort-Object { $turnWaiters[$_].since } | Select-Object -First 1) }
  while ($turnGrants.Count -gt 0 -and $turnGrants[0].at -lt $now - 600000) { $turnGrants.RemoveAt(0) }
  $active = @($turnGrants | ForEach-Object { $_.id } | Sort-Object -Unique)
  $mean = if ($active.Count -gt 0) { $turnGrants.Count / $active.Count } else { 0 }
  $weights = @{}
  $total = 0.0
  foreach ($waiter in $waiters) {
    $own = @($turnGrants | Where-Object { $_.id -eq $waiter }).Count
    $share = [Math]::Min(2.0, [Math]::Max(0.5, ($mean + 1) / ($own + 1)))
    $weight = (1 + ($now - $turnWaiters[$waiter].since) / 4000.0) * $share
    if ($waiter -eq $turn.lastHolder) { $weight *= 0.35 }
    $weights[$waiter] = $weight
    $total += $weight
  }
  $roll = Get-Random -Minimum 0.0 -Maximum $total
  foreach ($waiter in $waiters) {
    $roll -= $weights[$waiter]
    if ($roll -lt 0) { return $waiter }
  }
  return $waiters[-1]
}

function Request-Turn([string]$id, [bool]$isTransfer) {
  $now = Now-Milliseconds
  if ($turn.holder -and $turn.until -lt $now) { Release-Turn $now }
  if ($turn.holder -eq $id) {
    $turn.until = $now + $turnLeaseMs
    return 0
  }
  # A tab that stopped asking (closed, or gave up) must not block the queue
  foreach ($waiter in @($turnWaiters.Keys)) {
    if ($turnWaiters[$waiter].seen -lt $now - 3000) { $turnWaiters.Remove($waiter) }
  }
  if (-not $turnWaiters.ContainsKey($id)) { $turnWaiters[$id] = @{ since = $now; seen = $now; transfer = $isTransfer } }
  $turnWaiters[$id].seen = $now
  if (Transfer-Active $now) {
    # Everything else (other accounts, and the transferring tabs' own hunting) waits until the transfer ends
    if (-not $isTransfer) { return 500 }
    if ($turn.holder) { return 50 }
    # Seller and buyer take turns, so the buyer's polling cannot hold back the listing
    $otherWaiting = @($turnWaiters.Keys | Where-Object { $_ -ne $id -and $turnWaiters[$_].transfer -and $turnWaiters[$_].seen -ge $now - 1000 }).Count -gt 0
    if ($id -eq $turn.lastHolder -and $otherWaiting) { return 50 }
    $switchAt = $turn.freeAt + $turn.switchGap
    if ($id -ne $turn.lastHolder -and $now -lt $switchAt) { return [Math]::Max(50, $switchAt - $now) }
    Grant-Turn $id $now
    return 0
  }
  if ($turn.holder) { return 300 }
  # A person finishes a quick burst on one window before switching; cap it so other accounts still get a go
  if ($id -eq $turn.lastHolder -and $now -lt $turn.freeAt + 1500 -and $turn.streak -lt 6) {
    Grant-Turn $id $now
    $turn.streak++
    return 0
  }
  # The next tab is picked once and kept until it is served, so polling order does not decide it
  if (-not $turn.pick -or -not $turnWaiters.ContainsKey($turn.pick)) { $turn.pick = Pick-Waiter $now }
  if ($turn.pick -ne $id) { return 300 }
  $switchAt = $turn.freeAt + $turn.switchGap
  if ($id -ne $turn.lastHolder -and $now -lt $switchAt) { return [Math]::Max(100, $switchAt - $now) }
  foreach ($waiter in @($turnWaiters.Keys)) {
    if ($waiter -ne $id) { $turnSkips[$waiter] = 1 + [int]$turnSkips[$waiter] }
  }
  $turnSkips[$id] = 0
  $null = $turnGrants.Add(@{ at = $now; id = $id })
  $turn.pick = ''
  Grant-Turn $id $now
  $turn.streak = 0
  return 0
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
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/turn') {
    $id = $request.QueryString['id']
    if ($id -notmatch '^[\w-]{1,40}$') {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    $retry = Request-Turn $id ($request.QueryString['transfer'] -eq '1')
    $transferFlag = if (Transfer-Active (Now-Milliseconds)) { 'true' } else { 'false' }
    $body = if ($retry -eq 0) { '{"granted":true}' } else { '{"granted":false,"retry":' + $retry + ',"transfer":' + $transferFlag + '}' }
    Send-Response $response 200 'application/json; charset=utf-8' $body
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/turn/release') {
    $id = $request.QueryString['id']
    if ($id -and $turn.holder -eq $id) { Release-Turn (Now-Milliseconds) }
    if ($id) { $turnWaiters.Remove($id) }
    Send-Response $response 200 'application/json; charset=utf-8' '{"ok":true}'
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/focus') {
    # The tab ends its title with an invisible marker: the account id in binary as zero-width characters
    $id = $request.QueryString['id']
    if ($id -notmatch '^\d{1,15}$') {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    $bits = [Convert]::ToString([long]$id, 2).Replace('0', [string][char]0x200B).Replace('1', [string][char]0x200C)
    $result = [WindowFocus]::Focus([string][char]0x2063 + $bits + [string][char]0x2063)
    Send-Response $response 200 'application/json; charset=utf-8' ('{"result":"' + $result + '"}')
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/global') {
    Send-Response $response 200 'application/json; charset=utf-8' (Global-PauseJson)
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/global') {
    $mode = $request.QueryString['mode']
    if ($mode -notin @('run', 'temp', 'stop')) {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    $minutes = [Math]::Min([Math]::Max([int]$request.QueryString['minutes'], 1), 1440)
    $globalPause.mode = $mode
    $globalPause.until = if ($mode -eq 'temp') { [long](Now-Milliseconds) + [long]$minutes * 60000 } else { 0 }
    [System.IO.File]::WriteAllText($globalPausePath, ('{"mode":"' + $globalPause.mode + '","until":' + $globalPause.until + '}'), $utf8)
    Write-Host "$(Get-Date -Format HH:mm:ss) global pause: $mode"
    Send-Response $response 200 'application/json; charset=utf-8' (Global-PauseJson)
    return
  }
  if ($request.HttpMethod -eq 'GET' -and $path -eq '/shared') {
    Send-Response $response 200 'application/json; charset=utf-8' $script:sharedSettings
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/shared') {
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $raw = $reader.ReadToEnd()
    $reader.Close()
    try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null }
    if ($raw.Length -gt 10000 -or -not $parsed -or -not $parsed.at) {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    # Two tabs saving at once: keep the newer one
    $current = $script:sharedSettings | ConvertFrom-Json
    if (-not $current.at -or [long]$parsed.at -ge [long]$current.at) {
      $script:sharedSettings = $raw
      Write-Host "$(Get-Date -Format HH:mm:ss) shared settings updated"
    }
    Send-Response $response 200 'application/json; charset=utf-8' '{"ok":true}'
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/turn/transfer') {
    $id = $request.QueryString['id']
    if ($id -notmatch '^[\w-]{1,40}$') {
      Send-Response $response 400 'text/plain' 'bad request'
      return
    }
    $now = Now-Milliseconds
    # Capped so a tab that never says it is done cannot stop the other accounts for long
    $milliseconds = [Math]::Min([Math]::Max([int]$request.QueryString['ms'], 1000), 180000)
    if (-not (Transfer-Active $now)) {
      $transfer.mode = if ($request.QueryString['mode'] -eq 'fast') { 'fast' } else { 'human' }
      $transfer.until = 0
    }
    $transfer.ids[$id] = $true
    $transfer.until = [Math]::Max([long]$transfer.until, [long]($now + $milliseconds))
    # The last normal release chose a 1-3 s gap; the transfer should not wait for it
    $turn.switchGap = New-SwitchGap $now
    Write-Host "$(Get-Date -Format HH:mm:ss) transfer priority on ($($transfer.mode)) for $id"
    Send-Response $response 200 'application/json; charset=utf-8' '{"ok":true}'
    return
  }
  if ($request.HttpMethod -eq 'POST' -and $path -eq '/turn/transfer/end') {
    $id = $request.QueryString['id']
    if ($id -and $transfer.ids.ContainsKey($id)) {
      $transfer.ids.Remove($id)
      if ($transfer.ids.Count -eq 0) { Write-Host "$(Get-Date -Format HH:mm:ss) transfer priority off" }
    }
    Send-Response $response 200 'application/json; charset=utf-8' '{"ok":true}'
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
