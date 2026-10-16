# Local Developer Accelerator for Optimizely - one-line installer for Windows.
#   irm https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/install.ps1 | iex
# Options (environment variables, because a piped script takes no parameters):
#   LDA_VERSION   pin a release, for example v1.1.0 (default: the latest release)
#   GITHUB_TOKEN  optional; sent only to api.github.com to avoid its rate limit
#   LDA_INSTALL_API  override the releases API base (testing and mirrors only)
# Works in Windows PowerShell 5.1 and PowerShell 7. Needs no administrator rights.
# It never installs Node.js; it installs this CLI with npm after verifying its SHA-256.
& {
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $savedProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  $repo = 'coding-koala-io/local-developer-accelerator'
  $temp = $null

  function Fail([string]$cause, [string]$fix) {
    $e = New-Object Exception ("$cause`n  Fix: $fix")
    $e.Data['lda'] = $true
    throw $e
  }

  try {
    if ($PSVersionTable.PSVersion.Major -lt 6) {
      # Windows PowerShell 5.1 may default to TLS 1.0; GitHub requires TLS 1.2.
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }

    Write-Host ''
    Write-Host 'Local Developer Accelerator for Optimizely - by Coding Koala' -ForegroundColor Cyan
    Write-Host 'Development and research use only. Never use in production.' -ForegroundColor Yellow
    Write-Host '- Local stand-ins for Optimizely cloud services; behaviour differs from the real services.'
    Write-Host '- Runs on this machine only. No telemetry. Provided as is, without warranty. Licence: BSL 1.1.'
    Write-Host '- Independent project; not affiliated with, sponsored by or endorsed by Optimizely.'
    Write-Host ''

    # 1. Node.js 24+ and npm (never installed automatically).
    $nodeHelp = 'Install Node.js 24 or newer, then open a new terminal and run this command again: winget install OpenJS.NodeJS.LTS  (or download it from https://nodejs.org)'
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { Fail 'Node.js was not found on PATH.' $nodeHelp }
    $nodeVersion = (& $node.Source --version | Out-String).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.') { Fail "Could not read the Node.js version (got '$nodeVersion')." $nodeHelp }
    if ([int]$Matches[1] -lt 24) { Fail "Node.js $nodeVersion is too old; this CLI needs Node.js 24 or newer." $nodeHelp }
    # npm.cmd, not npm.ps1: the .ps1 shim can be blocked by the execution policy.
    $npm = Get-Command npm.cmd, npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { Fail 'npm was not found on PATH.' 'npm ships with Node.js; reinstall Node.js 24 or newer (winget install OpenJS.NodeJS.LTS, or https://nodejs.org) and open a new terminal.' }
    Write-Host "Node.js $nodeVersion and npm found."

    # 2. Which release.
    $api = if ($env:LDA_INSTALL_API) { $env:LDA_INSTALL_API.TrimEnd('/') } else { "https://api.github.com/repos/$repo" }
    $pin = if ($env:LDA_VERSION) { $env:LDA_VERSION.Trim() } else { '' }
    if ($pin) {
      if ($pin -notmatch '^v?\d+\.\d+\.\d+$') { Fail "LDA_VERSION '$pin' is not a version like v1.1.0." 'Set LDA_VERSION to a release tag such as v1.1.0, or remove it to install the latest release: Remove-Item Env:LDA_VERSION' }
      if (-not $pin.StartsWith('v')) { $pin = "v$pin" }
      $releaseUrl = "$api/releases/tags/$pin"
    } else { $releaseUrl = "$api/releases/latest" }
    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'lda-installer' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
    try {
      $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -UseBasicParsing -TimeoutSec 30
    } catch {
      $status = 0
      if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
      if ($status -eq 404 -and $pin) { Fail "Release $pin of $repo was not found." "Check the tag at https://github.com/$repo/releases, or remove LDA_VERSION to install the latest." }
      if ($status -eq 404) { Fail "No release of $repo was found." "See https://github.com/$repo/releases." }
      if ($status -eq 403 -or $status -eq 429) { Fail "GitHub refused the request (HTTP $status), usually its hourly rate limit." 'Wait an hour, or set $env:GITHUB_TOKEN to a GitHub token (no scopes needed) and run again.' }
      Fail "Could not reach the GitHub releases API ($($_.Exception.Message))." 'Check your internet connection or proxy, then run again.'
    }
    $tag = if ($release -and $release.PSObject.Properties['tag_name']) { [string]$release.tag_name } else { '' }
    if ($tag -notmatch '^v(\d+\.\d+\.\d+)$') { Fail "The release has an unexpected tag '$tag'." "Install manually from https://github.com/$repo/releases." }
    $version = $Matches[1]
    $tgzName = "coding-koala-io-accelerator-$version.tgz"
    $assets = if ($release.PSObject.Properties['assets']) { @($release.assets) } else { @() }
    $tgzAsset = $assets | Where-Object { $_.name -eq $tgzName } | Select-Object -First 1
    $sumsAsset = $assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
    if (-not $tgzAsset -or -not $sumsAsset) { Fail "Release $tag has no $tgzName and SHA256SUMS." "Install manually from https://github.com/$repo/releases." }
    foreach ($u in @($tgzAsset.browser_download_url, $sumsAsset.browser_download_url)) {
      if ([string]$u -notmatch '^(https://|http://(127\.0\.0\.1|localhost)[:/])') { Fail "The release lists a download address that is not HTTPS ($u)." 'Do not continue; report this at https://github.com/coding-koala-io/local-developer-accelerator/issues.' }
    }
    Write-Host "Installing the CLI $tag ..."

    # 3. Download and verify.
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('lda-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $tgz = Join-Path $temp $tgzName
    $sums = Join-Path $temp 'SHA256SUMS'
    try {
      Invoke-WebRequest -Uri $tgzAsset.browser_download_url -OutFile $tgz -UseBasicParsing -TimeoutSec 300 -Headers @{ 'User-Agent' = 'lda-installer' }
      Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sums -UseBasicParsing -TimeoutSec 60 -Headers @{ 'User-Agent' = 'lda-installer' }
    } catch { Fail "Download failed ($($_.Exception.Message))." 'Check your internet connection or proxy, then run again.' }
    $expected = $null
    foreach ($line in [IO.File]::ReadAllLines($sums)) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $tgzName) { $expected = $Matches[1].ToLowerInvariant() }
    }
    if (-not $expected) { Fail "SHA256SUMS of $tag has no line for $tgzName." "Do not install this download; report it at https://github.com/$repo/issues." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tgz).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "Checksum mismatch for $tgzName (expected $expected, got $actual). The download is damaged or was tampered with; nothing was installed." 'Run the command again. If it keeps failing, report it at https://github.com/coding-koala-io/local-developer-accelerator/issues.' }
    Write-Host "SHA-256 verified ($actual)."

    # 4. Install with npm (user-level global prefix; no administrator rights).
    & $npm.Source i -g $tgz --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." 'Read the npm messages above. If npm reports EPERM or EACCES, your npm global folder is not writable; run "npm config get prefix" and fix that folder, then run this again.' }

    # 5. Confirm.
    $prefix = (& $npm.Source prefix -g | Out-String).Trim()
    $lda = Join-Path $prefix 'lda.cmd'
    if (-not (Test-Path -LiteralPath $lda)) { $found = Get-Command lda.cmd -ErrorAction SilentlyContinue | Select-Object -First 1; if ($found) { $lda = $found.Source } }
    $installed = (& $lda --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $installed) { Fail 'The CLI was installed but "lda --version" did not run.' "Open a new terminal and run lda --version. The npm global folder is $prefix." }
    Write-Host ''
    Write-Host "Installed lda $installed." -ForegroundColor Green
    $onPath = @($env:Path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $prefix.TrimEnd('\')) }).Count -gt 0
    if (-not $onPath) { Write-Host "Note: $prefix is not on PATH in this terminal. Open a new terminal, or add that folder to PATH." -ForegroundColor Yellow }
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  lda                        open the manager (first run asks you to accept the notice)'
    Write-Host '  lda install graph assets   install LDA Local Graph and LDA Local Assets'
    Write-Host '  lda adopt                  take over an older install without moving its data'
    Write-Host '  lda tray                   start the tray icon'
    Write-Host '  lda self-update            update this CLI later'
  } catch {
    Write-Host ''
    if ($_.Exception.Data['lda']) { Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red }
    else { Write-Host "Install failed: $($_.Exception.Message)`n  Fix: run the command again; if it keeps failing, report it at https://github.com/$repo/issues." -ForegroundColor Red }
  } finally {
    $ProgressPreference = $savedProgress
    if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
