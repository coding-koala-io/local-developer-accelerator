[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigFile)
# PowerShell 5.1, STA, user session only. All operations go through the CLI.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# CATALOG-KEYS (kept identical to src/catalog.js by tests)
$script:CatalogKeys=@('graph','assets')
function Test-ModuleKey([string]$Key) {
    # tray.json is user-writable: only known catalogue keys may reach a command line.
    return ($Key -cmatch '^[a-z-]+$') -and ($script:CatalogKeys -ccontains $Key)
}
function Get-HealthState([string]$Body,[string]$Key) {
    # ok = HTTP 2xx (already true when a body arrives) and product absent (legacy) or equal to the module key.
    try {$h=$Body | ConvertFrom-Json} catch {return @{ok=$false; legacy=$false}}
    if ($h -isnot [Management.Automation.PSCustomObject]) {return @{ok=$false; legacy=$false}}
    $product=$h.PSObject.Properties['product']
    if ($null -eq $product -or [string]::IsNullOrEmpty([string]$product.Value)) {return @{ok=$true; legacy=$true}}
    return @{ok=([string]$product.Value -ceq $Key); legacy=$false}
}
function Get-CliPaths {
    $node=[string]$script:config.node; $cli=[string]$script:config.cli
    if (!$cli.EndsWith('\bin\lda.js',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $cli -PathType Leaf)) {throw 'tray.json does not name an existing ...\bin\lda.js. Run lda tray again.'}
    if (!$node.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $node -PathType Leaf)) {throw 'tray.json does not name an existing node.exe. Run lda tray again.'}
    return @{Node=$node; Cli=$cli}
}
function Format-ProcessArgument([string]$Value) {
    # Quote every argument; trailing backslashes are doubled so the closing quote stays a quote.
    if ($Value -match '["\x00-\x1f]') {throw 'Unsafe argument for the CLI.'}
    return '"'+($Value -replace '(\\+)$','$1$1')+'"'
}
function Invoke-Cli([string[]]$Arguments,[switch]$Console) {
    foreach ($a in $Arguments) {if ($a -cnotmatch '^-{0,2}[A-Za-z][A-Za-z-]*$') {throw "Unsafe CLI argument: $a"}}
    $paths=Get-CliPaths
    if ($Console) {
        $call='& '+((@($paths.Node,$paths.Cli)+$Arguments | ForEach-Object {"'"+$_.Replace("'","''")+"'"}) -join ' ')
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($call))
        # Windows PowerShell 5.1 by System32 path, started without the tray's PSModulePath so it builds its own
        # default (a value inherited from pwsh 7 breaks core modules). The tray's own value is restored after.
        $exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        $savedModulePath=$env:PSModulePath
        try {
            Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue
            Start-Process -FilePath $exe -ArgumentList '-NoProfile','-NoExit','-EncodedCommand',$encoded | Out-Null
        } finally {if ($null -ne $savedModulePath) {$env:PSModulePath=$savedModulePath}}
    } else {
        $cliArgs=@(@($paths.Cli)+$Arguments | ForEach-Object {Format-ProcessArgument $_})
        Start-Process -FilePath $paths.Node -WindowStyle Hidden -ArgumentList $cliArgs | Out-Null
    }
}
function Update-Health {
    # Non-blocking: collect finished requests, then start new ones. The UI thread never waits on HTTP.
    foreach ($module in @($script:config.modules)) {
        $key=[string]$module.key; if (!(Test-ModuleKey $key)) {continue}
        $task=$null; if ($script:pending.ContainsKey($key)) {$task=$script:pending[$key]}
        if ($task -and $task.IsCompleted) {
            if ($task.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion) {$script:health[$key]=Get-HealthState $task.Result $key}
            else {$null=$task.Exception; $script:health[$key]=@{ok=$false; legacy=$false; down=$true}}
            $script:pending.Remove($key); $task=$null
        }
        if (!$task) {$script:pending[$key]=$script:http.GetStringAsync("http://127.0.0.1:$([int]$module.port)/health")}
    }
}
function Add-Action($Parent,[string]$Text,[scriptblock]$Callback) {
    $item=New-Object Windows.Forms.ToolStripMenuItem($Text)
    $item.add_Click($Callback)
    if ($Parent -is [Windows.Forms.ContextMenuStrip]) {$Parent.Items.Add($item) | Out-Null} else {$Parent.DropDownItems.Add($item) | Out-Null}
    return $item
}
function Refresh-Tray {
    if ($stopEvent.WaitOne(0)) {$context.ExitThread(); return}
    try {$script:config=[IO.File]::ReadAllText($ConfigFile,[Text.Encoding]::UTF8) | ConvertFrom-Json} catch {return}
    Update-Health
    if ($menu.Visible) {return}
    $running=0; $healthy=0
    $oldItems=@($menu.Items); $menu.Items.Clear(); foreach ($old in $oldItems) {$old.Dispose()}
    $header=New-Object Windows.Forms.ToolStripMenuItem('Local Developer Accelerator - Development only'); $header.Enabled=$false; $menu.Items.Add($header) | Out-Null
    $modules=@($script:config.modules | Where-Object {Test-ModuleKey ([string]$_.key)})
    foreach ($module in $modules) {
        $key=[string]$module.key; $port=[int]$module.port
        if ($script:health.ContainsKey($key)) {$state=$script:health[$key]; if (!$state.ContainsKey('down')) {$running++}; if ($state.ok) {$healthy++}}
        $sub=New-Object Windows.Forms.ToolStripMenuItem("$($module.product) :$port")
        $menu.Items.Add($sub) | Out-Null
        Add-Action $sub 'Open dashboard' {Invoke-Cli @('open',$key)}.GetNewClosure() | Out-Null
        if ([bool](Get-Field $module 'legacy' $false)) {
            # Legacy services are changed only by lda adopt.
            $note=New-Object Windows.Forms.ToolStripMenuItem('Legacy install - run lda adopt'); $note.Enabled=$false; $sub.DropDownItems.Add($note) | Out-Null
        } else {
            Add-Action $sub 'Start' {Invoke-Cli @('start',$key)}.GetNewClosure() | Out-Null
            Add-Action $sub 'Stop' {Invoke-Cli @('stop',$key)}.GetNewClosure() | Out-Null
            Add-Action $sub 'Restart' {Invoke-Cli @('restart',$key)}.GetNewClosure() | Out-Null
        }
        Add-Action $sub 'View logs' {Invoke-Cli @('logs',$key,'-f') -Console}.GetNewClosure() | Out-Null
    }
    $color='#7b858b'; if ($running -gt 0) {if ($healthy -eq $modules.Count) {$color='#258151'} else {$color='#bc841b'}}
    $newIcon=New-StatusIcon $color; $notify.Icon=$newIcon; if ($script:icon) {$script:icon.Dispose()}; $script:icon=$newIcon
    # NotifyIcon on .NET Framework limits Text to 63 characters; the full label is in the menu.
    $tooltip="Local Developer Accelerator $([char]0x2014) $running of $($script:config.total) running $([char]0x00b7) Development only"
    $header.Text=$tooltip
    $notify.Text=$tooltip.Substring(0,[Math]::Min(63,$tooltip.Length))
    $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator)) | Out-Null
    # start/stop --all skip legacy services with a note.
    Add-Action $menu 'Start all' {Invoke-Cli @('start','--all')} | Out-Null
    Add-Action $menu 'Stop all' {Invoke-Cli @('stop','--all')} | Out-Null
    Add-Action $menu 'Open hub' {Invoke-Cli @('hub','--open')} | Out-Null
    $updates=@($modules | Where-Object {$_.update}).Count
    if ($updates -gt 0) {Add-Action $menu "Updates available ($updates)..." {Invoke-Cli @('upgrade','--all','--check') -Console} | Out-Null}
    Add-Action $menu 'Run doctor' {Invoke-Cli @('doctor') -Console} | Out-Null
    $settings=New-Object Windows.Forms.ToolStripMenuItem('Settings'); $menu.Items.Add($settings) | Out-Null
    $login=Add-Action $settings 'Start at login' {
        $enabled=Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name LocalDeveloperAccelerator -ErrorAction SilentlyContinue
        if ($enabled) {Invoke-Cli @('tray','--remove-at-login')} else {Invoke-Cli @('tray','--at-login')}
    }
    $login.Checked=[bool](Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name LocalDeveloperAccelerator -ErrorAction SilentlyContinue)
    $daily=Add-Action $settings 'Check for updates daily' {if ($script:config.checkUpdates) {Invoke-Cli @('config','set','checkUpdates','false')} else {Invoke-Cli @('config','set','checkUpdates','true')}}
    $daily.Checked=[bool]$script:config.checkUpdates
    Add-Action $menu 'About' {[Windows.Forms.MessageBox]::Show([string]$script:config.about,'Local Developer Accelerator') | Out-Null} | Out-Null
    Add-Action $menu 'Quit tray (services keep running)' {$context.ExitThread()} | Out-Null
    if ($script:config.checkUpdates -and ([DateTime]::UtcNow-$script:lastDaily).TotalHours -ge 24) {$script:lastDaily=[DateTime]::UtcNow; Invoke-Cli @('status','--check-updates')}
}
function Get-Field($Object, [string]$Name, $Default=$null) {
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -ne $prop) { return $prop.Value }
    return $Default
}
# Icon.GetHicon owns a native handle; release it after making an independent clone.
function New-StatusIcon([string]$Color) {
    $bitmap=New-Object Drawing.Bitmap(32,32); $g=[Drawing.Graphics]::FromImage($bitmap)
    $brush=New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($Color))
    try {
        $g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([Drawing.Color]::Transparent); $g.FillEllipse($brush,3,3,26,26)
        $handle=$bitmap.GetHicon(); $borrowed=[Drawing.Icon]::FromHandle($handle)
        try {return $borrowed.Clone()} finally {$borrowed.Dispose(); [LdaIconHandle]::DestroyIcon($handle) | Out-Null}
    } finally {$brush.Dispose(); $g.Dispose(); $bitmap.Dispose()}
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class LdaIconHandle { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon); }
'@
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$created=$false
$mutex=New-Object Threading.Mutex($true,('Local\LdaTray-'+$sid),[ref]$created)
if (!$created) {$mutex.Dispose(); exit 0}
$stopEvent=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::ManualReset,('Local\LdaTrayStop-'+$sid))
$stopEvent.Reset() | Out-Null
$notify=New-Object Windows.Forms.NotifyIcon
$menu=New-Object Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip=$menu
$context=New-Object Windows.Forms.ApplicationContext
$script:config=$null
$script:lastDaily=[DateTime]::MinValue
$script:icon=$null
$script:health=@{}
$script:pending=@{}
$script:http=New-Object Net.Http.HttpClient
$script:http.Timeout=[TimeSpan]::FromSeconds(1)
$timer=New-Object Windows.Forms.Timer; $timer.Interval=10000; $timer.add_Tick({Refresh-Tray})
# First health answers arrive asynchronously; show them shortly after start instead of after 10 s.
$firstTimer=New-Object Windows.Forms.Timer; $firstTimer.Interval=1500; $firstTimer.add_Tick({$firstTimer.Stop(); Refresh-Tray})
# Separate stop poll makes --stop responsive without changing the health polling interval.
$stopTimer=New-Object Windows.Forms.Timer; $stopTimer.Interval=500; $stopTimer.add_Tick({if ($stopEvent.WaitOne(0)) {$context.ExitThread()}})
try {
    Refresh-Tray; $notify.Visible=$true; $timer.Start(); $firstTimer.Start(); $stopTimer.Start(); [Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop(); $timer.Dispose(); $firstTimer.Dispose(); $stopTimer.Dispose(); $notify.Visible=$false; $notify.Dispose(); $menu.Dispose(); if ($script:icon) {$script:icon.Dispose()}; $script:http.Dispose(); $stopEvent.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose(); $context.Dispose()
}
