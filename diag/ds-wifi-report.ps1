<#
  pFMS Driver Station Wi-Fi check.

  Reads what Windows recorded about this laptop's Wi-Fi (connects,
  disconnects and their reasons, driver errors, sleep, power settings) and
  sends it to the field's pFMS so drop-outs during matches can be diagnosed.

  It only reads. It changes no settings, and it never reads Wi-Fi passwords
  or saved network profiles.

  On the Driver Station laptop: download it from the pFMS team page, then
  right-click the file and choose "Run with PowerShell" (on Windows 11 it
  is under "Show more options").

  Don't turn this into `irm <url> | iex` or a .cmd that does the same:
  Microsoft Defender blocks that command line as Trojan:Win32/Commando.A!ml
  (seen 2026-09-28), and it would on every team laptop too.

  Options:  -Hours 48   look further back (default 24)
            -NoUpload   only show the result here
            -OutFile x  also save the full report as JSON
            -NoPause    don't wait for Enter at the end
            -Server u   send to a different pFMS

  Pure ASCII on purpose: Windows PowerShell 5.1 reads a downloaded script
  without a byte-order mark as the local code page.
#>
param(
  [double]$Hours = 24,
  [string]$Server = '__PFMS_SERVER__',
  [switch]$NoUpload,
  [string]$OutFile,
  [switch]$NoPause
)

# Everything runs inside one script block so nothing is left behind in the
# caller's session. Windows PowerShell 5.1 compatible.
& {
  param($Hours, $Server, $NoUpload, $OutFile, $NoPause)

  $ErrorActionPreference = 'Continue'
  $ProgressPreference = 'SilentlyContinue'
  $schema = 'pfms-ds-wifi-report/1'
  $since = (Get-Date).AddHours(-1 * $Hours)
  $errors = New-Object System.Collections.Generic.List[object]
  $problems = New-Object System.Collections.Generic.List[object]

  function Note-Error([string]$where, $err) {
    $errors.Add([ordered]@{ where = $where; error = [string]$err })
  }

  function Add-Problem([string]$severity, [string]$code, [string]$text) {
    $problems.Add([ordered]@{ severity = $severity; code = $code; text = $text })
  }

  function Iso($date) {
    if ($null -eq $date) { return $null }
    return ([datetime]$date).ToUniversalTime().ToString('o')
  }

  function Run-Text([string]$exe, [string[]]$arguments) {
    try {
      $out = & $exe @arguments 2>&1 | Out-String
      return $out.Trim()
    } catch {
      Note-Error "$exe $($arguments -join ' ')" $_
      return $null
    }
  }

  # Event rows with the structured EventData fields, so reasons and SSIDs
  # survive even when the message text is in another language.
  function Get-EventRows([hashtable]$filter, [int]$max, [int]$messageChars) {
    $rows = New-Object System.Collections.Generic.List[object]
    try {
      $events = Get-WinEvent -FilterHashtable $filter -MaxEvents $max -ErrorAction Stop
    } catch {
      if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return , $rows.ToArray() }
      Note-Error ("events " + $filter.LogName) $_
      return , $rows.ToArray()
    }
    foreach ($e in $events) {
      $data = [ordered]@{}
      try {
        $xml = [xml]$e.ToXml()
        foreach ($d in @($xml.Event.EventData.Data)) {
          if ($d -and $d.Name) { $data[$d.Name] = [string]$d.'#text' }
        }
      } catch { }
      $msg = $e.Message
      if ($msg -and $msg.Length -gt $messageChars) { $msg = $msg.Substring(0, $messageChars) }
      $rows.Add([ordered]@{
          time     = Iso $e.TimeCreated
          id       = $e.Id
          level    = $e.LevelDisplayName
          provider = $e.ProviderName
          message  = $msg
          data     = $data
        })
    }
    # Oldest first reads like a timeline.
    $arr = $rows.ToArray()
    [array]::Reverse($arr)
    return , $arr
  }

  Write-Host ''
  Write-Host 'pFMS Driver Station Wi-Fi check' -ForegroundColor Cyan
  Write-Host ("Looking at the last {0} hours. This only reads; it changes nothing." -f $Hours)
  Write-Host ''

  # --- This laptop ---
  $computer = [ordered]@{ name = $env:COMPUTERNAME; user = $env:USERNAME }
  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $computer.os = $os.Caption
    $computer.osVersion = $os.Version
    $computer.lastBoot = Iso $os.LastBootUpTime
    $computer.manufacturer = $cs.Manufacturer
    $computer.model = $cs.Model
  } catch { Note-Error 'computer' $_ }
  $computer.powershell = $PSVersionTable.PSVersion.ToString()
  $computer.isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $computer.timeZone = [TimeZoneInfo]::Local.Id
  $computer.utcOffsetMinutes = [int][TimeZoneInfo]::Local.GetUtcOffset((Get-Date)).TotalMinutes

  # --- FRC Driver Station ---
  $ds = [ordered]@{}
  $frcDocs = Join-Path $env:PUBLIC 'Documents\FRC'
  try {
    $ini = Join-Path $frcDocs 'FRC DS Data Storage.ini'
    if (Test-Path $ini) {
      $line = Select-String -Path $ini -Pattern '^\s*TeamNumber\s*=\s*"?(\d+)' | Select-Object -First 1
      if ($line) { $ds.teamNumber = [int]$line.Matches[0].Groups[1].Value }
    }
    $exe = Join-Path ${env:ProgramFiles(x86)} 'FRC Driver Station\DriverStation.exe'
    if (Test-Path $exe) { $ds.version = (Get-Item $exe).VersionInfo.ProductVersion }
    $ds.running = [bool](Get-Process -Name 'DriverStation' -ErrorAction SilentlyContinue)
  } catch { Note-Error 'driver station' $_ }

  # The DS's own event logs (enable/disable, FMS connect/lost) for the same
  # window, so a Wi-Fi drop can be lined up with what the DS did. Raw files,
  # decoded later on the server side.
  $dsEvents = New-Object System.Collections.Generic.List[object]
  try {
    $logDir = Join-Path $frcDocs 'Log Files'
    if (Test-Path $logDir) {
      $budget = 6MB
      $files = Get-ChildItem -Path $logDir -Recurse -Filter '*.dsevents' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $since } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 30
      foreach ($f in $files) {
        if ($f.Length -gt $budget) { break }
        $budget -= $f.Length
        $dsEvents.Add([ordered]@{
            name      = $f.Name
            lastWrite = Iso $f.LastWriteTime
            bytes     = $f.Length
            base64    = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
          })
      }
    }
  } catch { Note-Error 'dsevents' $_ }

  # --- Adapters, addresses, power ---
  $adapters = @()
  $wifiAdapters = @()
  try {
    $all = Get-NetAdapter -ErrorAction Stop
    foreach ($a in $all) {
      $isWifi = ($a.PhysicalMediaType -match '802\.11') -or ($a.NdisPhysicalMedium -eq 9)
      $row = [ordered]@{
        name          = $a.Name
        description   = $a.InterfaceDescription
        status        = [string]$a.Status
        wifi          = $isWifi
        virtual       = [bool]$a.Virtual
        linkSpeed     = $a.LinkSpeed
        mac           = $a.MacAddress
        driverVersion = $a.DriverVersion
        driverDate    = $a.DriverDate
        driverProvider = $a.DriverProvider
      }
      if ($isWifi) {
        try {
          $pm = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop
          $row.powerManagement = [ordered]@{
            allowComputerToTurnOffDevice = [string]$pm.AllowComputerToTurnOffDevice
            deviceSleepOnDisconnect      = [string]$pm.DeviceSleepOnDisconnect
            selectiveSuspend             = [string]$pm.SelectiveSuspend
          }
        } catch { Note-Error "power management $($a.Name)" $_ }
        try {
          $row.advanced = @(Get-NetAdapterAdvancedProperty -Name $a.Name -ErrorAction Stop |
              ForEach-Object { [ordered]@{ name = $_.DisplayName; value = $_.DisplayValue } })
        } catch { Note-Error "advanced properties $($a.Name)" $_ }
        $wifiAdapters += $row
      }
      $adapters += $row
    }
  } catch { Note-Error 'adapters' $_ }

  # Both families: pFMS matches a laptop to its station by any of these, so a
  # laptop that uploads over IPv6 is still found by its IPv4 address.
  $addresses = @()
  try {
    $addresses = @(Get-NetIPAddress -ErrorAction Stop |
        Where-Object {
          $_.IPAddress -ne '::1' -and $_.IPAddress -notlike '127.*' -and
          $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike 'fe80:*'
        } |
        ForEach-Object {
          [ordered]@{
            interface = $_.InterfaceAlias
            family    = [string]$_.AddressFamily
            address   = ($_.IPAddress -replace '%\d+$', '')
            prefix    = $_.PrefixLength
            origin    = [string]$_.PrefixOrigin
            suffix    = [string]$_.SuffixOrigin
          }
        })
  } catch { Note-Error 'addresses' $_ }
  $defaultRoutes = @()
  try {
    $defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0', '::/0' -ErrorAction Stop |
        ForEach-Object { [ordered]@{ interface = $_.InterfaceAlias; family = [string]$_.AddressFamily; gateway = $_.NextHop; metric = $_.RouteMetric + $_.InterfaceMetric } })
  } catch { Note-Error 'routes' $_ }

  $power = [ordered]@{}
  $power.activeScheme = Run-Text 'powercfg' @('/getactivescheme')
  # Wireless Adapter Settings > Power Saving Mode, AC and battery values.
  $power.wirelessAdapterSettings = Run-Text 'powercfg' @('/query', 'SCHEME_CURRENT', '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1')
  try {
    $bat = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
    if ($bat) {
      $power.hasBattery = $true
      $power.onBattery = ($bat.BatteryStatus -eq 1)
      $power.chargePercent = $bat.EstimatedChargeRemaining
    } else { $power.hasBattery = $false }
  } catch { Note-Error 'battery' $_ }

  # --- Wi-Fi state right now ---
  $wifiNow = [ordered]@{
    interfaces = Run-Text 'netsh' @('wlan', 'show', 'interfaces')
    drivers    = Run-Text 'netsh' @('wlan', 'show', 'drivers')
    settings   = Run-Text 'netsh' @('wlan', 'show', 'settings')
  }
  # Parse the English field names we care about; the raw text rides along
  # for everything else (and for other languages).
  $parsed = [ordered]@{}
  if ($wifiNow.interfaces) {
    foreach ($line in ($wifiNow.interfaces -split "`r?`n")) {
      if ($line -match '^\s*(SSID|BSSID|State|Radio type|Band|Channel|Signal|Receive rate \(Mbps\)|Transmit rate \(Mbps\)|Authentication|Profile)\s*:\s*(.+)$') {
        if (-not $parsed.Contains($Matches[1])) { $parsed[$Matches[1]] = $Matches[2].Trim() }
      }
    }
  }
  $wifiNow.parsed = $parsed

  # --- Event logs ---
  Write-Host 'Reading the Wi-Fi event log...'
  $wlan = Get-EventRows @{ LogName = 'Microsoft-Windows-WLAN-AutoConfig/Operational'; StartTime = $since } 4000 1500
  $netProfile = Get-EventRows @{ LogName = 'Microsoft-Windows-NetworkProfile/Operational'; StartTime = $since } 1000 600
  $systemProblems = Get-EventRows @{ LogName = 'System'; StartTime = $since; Level = 1, 2, 3 } 1500 800
  $powerEvents = Get-EventRows @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = $since; Id = 42, 105, 107, 506, 507 } 500 400

  # --- What looks wrong ---
  $disconnects = @($wlan | Where-Object { $_.id -eq 8003 })
  $failures = @($wlan | Where-Object { $_.id -eq 8002 })
  if ($disconnects.Count -gt 0) {
    Add-Problem 'warn' 'wifi-disconnects' ("Wi-Fi disconnected {0} times in the last {1} h." -f $disconnects.Count, $Hours)
    $byReason = $disconnects | Group-Object { if ($_.data.Reason) { $_.data.Reason } else { 'unknown' } } | Sort-Object Count -Descending
    foreach ($g in $byReason) { Add-Problem 'info' 'disconnect-reason' ("  {0} x  {1}" -f $g.Count, $g.Name) }
  }
  if ($failures.Count -gt 0) {
    Add-Problem 'warn' 'wifi-connect-failures' ("Wi-Fi failed to connect {0} times." -f $failures.Count)
  }
  $driverTrouble = @($systemProblems | Where-Object { $_.provider -match 'Netw|rtw|Rtl|athw|Qc|mrvl|mtk|MT7|BCM|NDIS|WLAN|Wlan' })
  if ($driverTrouble.Count -gt 0) {
    Add-Problem 'warn' 'wifi-driver-errors' ("The Wi-Fi driver logged {0} errors or warnings (for example, resets)." -f $driverTrouble.Count)
  }
  $sleeps = @($powerEvents | Where-Object { $_.id -eq 42 -or $_.id -eq 506 })
  if ($sleeps.Count -gt 0) {
    Add-Problem 'info' 'sleep' ("The laptop went to sleep {0} times; Wi-Fi drops on every sleep." -f $sleeps.Count)
  }
  foreach ($w in $wifiAdapters) {
    if ($w.powerManagement -and $w.powerManagement.allowComputerToTurnOffDevice -eq 'Enabled') {
      Add-Problem 'warn' 'adapter-power-off-allowed' ("Windows is allowed to turn off the Wi-Fi adapter ""{0}"" to save power." -f $w.name)
    }
  }
  if ($power.onBattery) {
    Add-Problem 'info' 'on-battery' ("Running on battery ({0}%). Battery power plans often put Wi-Fi into power saving." -f $power.chargePercent)
  }
  if ($parsed.Contains('Signal')) {
    $pct = [int]($parsed['Signal'] -replace '[^\d]', '')
    if ($pct -gt 0 -and $pct -lt 60) { Add-Problem 'warn' 'weak-signal' ("Wi-Fi signal is weak right now ({0})." -f $parsed['Signal']) }
  }
  if ($parsed.Contains('Band') -and $parsed['Band'] -match '2\.4') {
    Add-Problem 'info' '2.4ghz' 'Connected on 2.4 GHz right now, which is the most crowded band.'
  }
  $upOthers = @($adapters | Where-Object { $_.status -eq 'Up' -and -not $_.wifi })
  if ($upOthers.Count -gt 0) {
    Add-Problem 'info' 'other-adapters' ("Other network connections are up too: {0}" -f (($upOthers | ForEach-Object { $_.name }) -join ', '))
  }
  if ($problems.Count -eq 0) { Add-Problem 'ok' 'no-problems' 'No Wi-Fi problems found in the event log.' }

  $report = [ordered]@{
    schema          = $schema
    generatedAt     = Iso (Get-Date)
    windowStart     = Iso $since
    hours           = $Hours
    computer        = $computer
    driverStation   = $ds
    wifiNow         = $wifiNow
    adapters        = $adapters
    addresses       = $addresses
    defaultRoutes   = $defaultRoutes
    power           = $power
    problems        = $problems.ToArray()
    events          = [ordered]@{
      wlanAutoConfig = $wlan
      networkProfile = $netProfile
      systemProblems = $systemProblems
      power          = $powerEvents
    }
    dsEvents        = $dsEvents.ToArray()
    errors          = $errors.ToArray()
  }

  # --- Tell the person at the laptop ---
  Write-Host ''
  foreach ($p in $problems) {
    $color = 'Gray'
    if ($p.severity -eq 'warn') { $color = 'Yellow' }
    if ($p.severity -eq 'ok') { $color = 'Green' }
    Write-Host $p.text -ForegroundColor $color
  }
  if ($disconnects.Count -gt 0) {
    Write-Host ''
    Write-Host 'Most recent disconnects (local time):'
    foreach ($d in ($disconnects | Select-Object -Last 8)) {
      $when = ([datetime]$d.time).ToLocalTime().ToString('ddd HH:mm:ss')
      Write-Host ("  {0}  {1}  {2}" -f $when, $d.data.SSID, $d.data.Reason)
    }
  }
  Write-Host ''

  $json = $report | ConvertTo-Json -Depth 8 -Compress
  if ($OutFile) {
    [IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Saved the full report to $OutFile"
  }

  if ($NoUpload) { return }
  if (-not $Server -or $Server -like '__PFMS*') {
    Write-Host 'No pFMS address to send to. Run it with -Server http://pfms.tsl' -ForegroundColor Yellow
    return
  }
  try {
    # Windows PowerShell 5.1 sends a string body as ISO-8859-1, so send bytes.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $resp = Invoke-RestMethod -Method Post -Uri ($Server.TrimEnd('/') + '/api/diag/wifi-report') `
      -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 60 -UseBasicParsing
    Write-Host ("Sent to pFMS. Report {0}. Thank you!" -f $resp.id) -ForegroundColor Green
  } catch {
    $fallback = Join-Path $env:TEMP ("pfms-wifi-report-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [IO.File]::WriteAllText($fallback, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Could not reach pFMS ($($_.Exception.Message))." -ForegroundColor Yellow
    Write-Host "The report is saved at $fallback; please send it to the field staff."
  }
} $Hours $Server $NoUpload $OutFile $NoPause

# "Run with PowerShell" closes the window the moment the script ends, before
# anyone has read the result.
if (-not $NoPause) {
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
}
