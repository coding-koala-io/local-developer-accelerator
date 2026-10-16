# Based on the Graph service.ps1 safety model. PowerShell 5.1; no elevation in DryRun.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PlanFile,
    [Parameter(Mandatory=$true)][string]$PlanSha256,
    [string]$ResultFile,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$OutputEncoding = $utf8
# CATALOG-BEGIN (kept identical to src/catalog.js by tests)
$Modules = @{
    graph = @{ Product='LDA Local Graph'; CompatibleWith='Optimizely Graph'; Repo='coding-koala-io/lda-graph'; Port=8082; ServiceId='LdaGraph'; LegacyServiceId='OptimizelyGraphLocal'; RuntimeFolder='Graph'; MemoryMb=8192 }
    assets = @{ Product='LDA Local Assets'; CompatibleWith='Optimizely CMS DAM picker'; Repo='coding-koala-io/lda-assets'; Port=8083; ServiceId='LdaAssets'; LegacyServiceId='OptimizelyDamLocal'; RuntimeFolder='Assets'; MemoryMb=0 }
}
# CATALOG-END
$wrapperUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$wrapperSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$userRoot = Join-Path $env:LOCALAPPDATA 'Coding Koala\Local Developer Accelerator'
$cacheRoot = Join-Path $userRoot 'cache'
$plansRoot = Join-Path $userRoot 'plans'
$codeRoot = Join-Path $env:ProgramFiles 'Coding Koala\Local Developer Accelerator'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# External tools always come from System32 (GetSystemDirectory, not PATH or an environment variable).
$system32 = [Environment]::SystemDirectory
$tarExe = Join-Path $system32 'tar.exe'
$icaclsExe = Join-Path $system32 'icacls.exe'
$scExe = Join-Path $system32 'sc.exe'
$trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
# Principals trusted to change folders: SYSTEM, Administrators, TrustedInstaller.
$adminSids = @('S-1-5-18', 'S-1-5-32-544', $trustedInstallerSid)
$creatorOwnerSid = 'S-1-3-0'
$localServiceSid = 'S-1-5-19'
# Write data, append, write EA, delete child, write attributes, delete, change permissions, take ownership, GENERIC_ALL, GENERIC_WRITE.
$writeMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
$markerName = '.lda-runtime.json'
# Temporary files of an interrupted marker write: .lda-runtime.json.<32 hex>.tmp (administrators only).
$markerTempPattern = '^\.lda-runtime\.json\.[0-9a-fA-F]{32}\.tmp$'
$runtimeLayout = @('tenants.json', 'data', 'logs', 'service', 'backups', $markerName)
$versionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
$script:nodePath = $null
$script:plan = $null
$result = @{ok=$false; operations=@(); log=@()}
$resultStream = $null

function Get-Field($Object, [string]$Name, $Default=$null) {
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -ne $prop) { return $prop.Value }
    return $Default
}
function Full([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Is-Within([string]$Parent, [string]$Child) {
    return (Full $Child).StartsWith((Full $Parent) + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Hash-Bytes([byte[]]$Bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($h.ComputeHash($Bytes)).Replace('-','') } finally {$h.Dispose()}
}
function Hash-File([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Assert-NoReparse([string]$Path, [switch]$Recursive) {
    $current = Full $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw "Refusing junction or symbolic link: $current"}
        }
        $parent = Split-Path $current -Parent
        if ($parent -eq $current) {break}; $current = $parent
    }
    if ($Recursive -and (Test-Path -LiteralPath $Path)) {
        foreach ($entry in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw "Refusing reparse point: $($entry.FullName)"}
        }
    }
}
function Test-ReparsePoint([string]$Path) {
    return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}
# --- Owner and write-access trust for every folder and file the helper relies on. ---
function Get-PrincipalName([string]$Sid) {
    try { return (New-Object Security.Principal.SecurityIdentifier($Sid)).Translate([Security.Principal.NTAccount]).Value } catch { return $Sid }
}
function Find-UntrustedWriter($Acl, [switch]$AllowLocalService) {
    # The first principal outside SYSTEM, Administrators and TrustedInstaller (CREATOR OWNER only when
    # inherit-only; LocalService only where allowed) holding an Allow ACE with any write-type right.
    foreach ($rule in @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {continue}
        if (([int]$rule.FileSystemRights -band $writeMask) -eq 0) {continue}
        $sid = $rule.IdentityReference.Value
        if ($sid -in $adminSids) {continue}
        if ($sid -eq $creatorOwnerSid -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {continue}
        if ($AllowLocalService -and $sid -eq $localServiceSid) {continue}
        return $sid
    }
    return $null
}
function Assert-SafeItem([string]$Path, [switch]$AllowLocalService, [switch]$AdminOwner, [switch]$OwnerOnly) {
    # Not a reparse point, a trusted owner and no untrusted principal able to modify it.
    # -OwnerOnly is for well-known system parents (ProgramData, Program Files), whose own ACLs Windows manages.
    $item = Get-Item -LiteralPath $Path -Force
    if (!$OwnerOnly -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw "Refusing to use ${Path}: it is a junction or symbolic link. Remove or fix it as an administrator and retry."}
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $owners = @($adminSids)
    if (!$AdminOwner) { $owners += [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    if ($owner -notin $owners) {throw "Refusing to use ${Path}: it is owned by $(Get-PrincipalName $owner). Remove or fix it as an administrator and retry."}
    if ($OwnerOnly) {return}
    $writer = Find-UntrustedWriter $acl -AllowLocalService:$AllowLocalService
    if ($writer) {throw "Refusing to use ${Path}: $(Get-PrincipalName $writer) can modify it. Remove that access as an administrator (or choose another folder) and retry."}
}
# --- Runtime folder chain. ---
function Get-SystemParentFolders {
    # Well-known system folders that may hold the runtime; only their owner is checked.
    return @(@($env:ProgramData, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
}
function Get-RuntimeAncestors([string]$Root) {
    # Every folder between the volume root (excluded) and the runtime root (excluded), top first.
    $RuntimeRoot = Full $Root
    $volumeRoot = [IO.Path]::GetPathRoot($RuntimeRoot).TrimEnd('\')
    $folders = New-Object 'System.Collections.Generic.List[string]'
    $cursor = Split-Path $RuntimeRoot.TrimEnd('\') -Parent
    while ($cursor -and $cursor.TrimEnd('\') -ne $volumeRoot) { $folders.Insert(0, $cursor.TrimEnd('\')); $cursor = Split-Path $cursor -Parent }
    return $folders.ToArray()
}
function Assert-RuntimeChain([string]$Root) {
    # Top down: system parents (owner only), every other ancestor (no LocalService write), then the runtime root
    # (LocalService may modify runtime data). Missing folders are skipped; they are created later with a fixed DACL.
    $RuntimeRoot = Full $Root
    $systemParents = @(Get-SystemParentFolders)
    foreach ($folder in @(Get-RuntimeAncestors $RuntimeRoot)) {
        if (!(Test-Path -LiteralPath $folder)) { continue }
        if ($systemParents -contains $folder) { Assert-SafeItem $folder -AdminOwner -OwnerOnly; continue }
        Assert-SafeItem $folder
    }
    if (Test-Path -LiteralPath $RuntimeRoot) { Assert-SafeItem $RuntimeRoot -AllowLocalService }
}
function Assert-RuntimeTree([string]$Root, [string]$Id) {
    # The chain plus every descendant the service uses: service\ (LocalService read only, like its wrapper and XML),
    # service\logs, data and logs (LocalService may modify), and the runtime marker (administrators only).
    Assert-RuntimeChain $Root
    $r = Full $Root
    $service = Join-Path $r 'service'
    if (Test-Path -LiteralPath $service) { Assert-SafeItem $service }
    foreach ($name in @('service\logs', 'data', 'logs')) {
        $p = Join-Path $r $name
        if (Test-Path -LiteralPath $p) { Assert-SafeItem $p -AllowLocalService }
    }
    if ($Id) {
        foreach ($name in @("$Id.exe", "$Id.xml")) {
            $p = Join-Path $service $name
            if (Test-Path -LiteralPath $p) { Assert-SafeItem $p }
        }
    }
    $marker = Join-Path $r $markerName
    if (Test-Path -LiteralPath $marker) { Assert-SafeItem $marker }
}
function New-RestrictedSecurity([string]$Kind) {
    # Runtime: SYSTEM/Administrators Full, LocalService Modify. Service/Code: SYSTEM/Administrators Full,
    # Users/LocalService Read/Execute. Admin: SYSTEM/Administrators only. Protected: nothing is inherited.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $grants = @{'S-1-5-18'='FullControl'; 'S-1-5-32-544'='FullControl'}
    if ($Kind -eq 'Runtime') {$grants['S-1-5-19']='Modify'}
    if ($Kind -in @('Service','Code')) {$grants['S-1-5-19']='ReadAndExecute'; $grants['S-1-5-32-545']='ReadAndExecute'}
    foreach ($sid in $grants.Keys) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,$grants[$sid],'ContainerInherit,ObjectInherit','None','Allow')))
    }
    return $acl
}
function Set-RestrictedDirectoryAcl([string]$Path, [switch]$Service, [switch]$Code) {
    # Exact replacement, never /grant:r over an unknown explicit DACL.
    $kind = 'Runtime'
    if ($Service) {$kind = 'Service'}
    if ($Code) {$kind = 'Code'}
    $acl = New-RestrictedSecurity $kind
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-SecureDirectory([string]$Path, [string]$Kind) {
    # Created with its final protected DACL in one call, so it never exists with inherited permissive ACEs.
    # A folder that already exists here (for example one that appeared after a caller listed the missing folders)
    # gets the full trust check (reparse point, owner, untrusted write access) before any caller changes its
    # ownership or ACL; an untrusted one is refused.
    if (Test-Path -LiteralPath $Path) { Assert-SafeItem $Path -AllowLocalService:($Kind -eq 'Runtime'); return $false }
    [IO.Directory]::CreateDirectory($Path, (New-RestrictedSecurity $Kind)) | Out-Null
    # CreateDirectory also returns a folder another user created first (a creation race). Validate its owner,
    # write access and reparse state before any caller changes its ownership or ACL; refuse it when untrusted.
    Assert-SafeItem $Path -AllowLocalService:($Kind -eq 'Runtime')
    return $true
}
function New-RuntimeRoot([string]$Root) {
    # Check the existing chain, then create each missing folder top-down with its final DACL
    # (ancestors read-only for Users/LocalService, the runtime root with LocalService Modify) and check it at once.
    $RuntimeRoot = Full $Root
    Assert-RuntimeChain $RuntimeRoot
    $missing = New-Object 'System.Collections.Generic.List[string]'
    $cursor = $RuntimeRoot
    while ($cursor -and !(Test-Path -LiteralPath $cursor)) { $missing.Insert(0, $cursor.TrimEnd('\')); $cursor = Split-Path $cursor -Parent }
    foreach ($folder in $missing) {
        $isRoot = ($folder -eq $RuntimeRoot)
        $kind = 'Service'; if ($isRoot) {$kind = 'Runtime'}
        New-SecureDirectory $folder $kind | Out-Null
        Set-RestrictedDirectoryAcl $folder -Service:(!$isRoot)
        Assert-SafeItem $folder -AllowLocalService:$isRoot
    }
    Assert-RuntimeChain $RuntimeRoot
}
function New-RuntimeFolders($Ctx) {
    # data, logs, service and service\logs: created with a fixed DACL when missing, validated right before use.
    foreach ($name in @('data', 'logs', 'service', 'service\logs')) {
        $path = Join-Path $Ctx.Root $name
        $kind = 'Runtime'; if ($name -eq 'service') {$kind = 'Service'}
        New-SecureDirectory $path $kind | Out-Null
        Assert-SafeItem $path -AllowLocalService:($kind -eq 'Runtime')
    }
}
function Assert-RuntimeLayout([string]$Root) {
    # An existing data folder is reused only when empty or holding nothing but a runtime layout.
    if (!(Test-Path -LiteralPath $Root)) {return}
    foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Force)) {
        if ($entry.Name -notin $runtimeLayout -and $entry.Name -notmatch '^\.lda-runtime\.json\.[0-9a-fA-F]{32}\.tmp$') {throw "Refusing $Root because it contains $($entry.Name), which is not part of a runtime folder. Choose an empty folder or an existing runtime folder."}
    }
}
# --- Runtime identity: <runtime>\.lda-runtime.json ties a folder to one module and service id. ---
function New-AdminFileSecurity {
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true,$false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow')))
    }
    return $security
}
function Get-RuntimeMarker([string]$Root) {
    $file = Join-Path (Full $Root) $markerName
    if (!(Test-Path -LiteralPath $file)) {return $null}
    Assert-SafeItem $file
    try { return ([IO.File]::ReadAllText($file) | ConvertFrom-Json) } catch { throw "Refusing ${Root}: its runtime marker $file is not valid. Remove it as an administrator and retry." }
}
function Get-MarkerTemps([string]$Root) {
    # Leftover temporary files of an interrupted marker write.
    return @(Get-ChildItem -LiteralPath (Full $Root) -Force -File | Where-Object { $_.Name -match $markerTempPattern } | ForEach-Object { $_.FullName })
}
function Read-MarkerFile([string]$File) {
    # The parsed marker, or $null when the file is empty or not valid JSON (an interrupted write).
    try { return ([IO.File]::ReadAllText($File) | ConvertFrom-Json) } catch { return $null }
}
function Resolve-RuntimeMarker([string]$Root, [string]$Module, [string]$ServiceId) {
    # Reads the marker and repairs an interrupted marker write, only for this module and service id.
    # Every marker file and leftover temp must be administrators-only. A complete marker or temp for another
    # module always blocks, and nothing in that folder is changed. An unreadable marker is replaced only by a
    # complete leftover temp for this module, service id and path; leftover temps are removed once resolved.
    $r = Full $Root; $file = Join-Path $r $markerName
    $temps = @(Get-MarkerTemps $r)
    foreach ($t in $temps) { Assert-SafeItem $t }
    $exists = Test-Path -LiteralPath $file
    $marker = $null
    if ($exists) { Assert-SafeItem $file; $marker = Read-MarkerFile $file }
    if ($null -ne $marker) {
        $markModule = [string](Get-Field $marker 'module' ''); $markId = [string](Get-Field $marker 'serviceId' '')
        if ($markModule -ne $Module -or $markId -ne $ServiceId) {throw "Refusing ${r}: it is the runtime folder of $markModule ($markId), not $Module ($ServiceId). Choose another folder."}
    } else {
        $complete = $null
        foreach ($t in $temps) {
            $m = Read-MarkerFile $t
            if ($null -eq $m) {continue}
            $mm = [string](Get-Field $m 'module' ''); $mi = [string](Get-Field $m 'serviceId' ''); $mc = [string](Get-Field $m 'canonicalPath' '')
            if ($mm -ne $Module -or $mi -ne $ServiceId -or !$mc -or (Full $mc) -ne $r) {throw "Refusing ${r}: an interrupted runtime marker write in it belongs to $mm ($mi) at $mc, not $Module ($ServiceId). Choose another folder."}
            $complete = $t
        }
        if ($exists -and !$complete) {throw "Refusing ${Root}: its runtime marker $file is not valid. Remove it as an administrator and retry."}
        if ($complete) {
            if ($exists) {[IO.File]::Replace($complete, $file, [NullString]::Value)} else {[IO.File]::Move($complete, $file)}
            Assert-SafeItem $file
            $marker = Read-MarkerFile $file
            if ($null -eq $marker) {throw "Refusing ${Root}: its runtime marker $file is not valid. Remove it as an administrator and retry."}
            $result.log += "Recovered the runtime marker of $r from an interrupted write."
        }
    }
    foreach ($t in $temps) { if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force; $result.log += "Removed the leftover runtime marker temp file $t." } }
    return $marker
}
function Assert-RuntimeIdentity([string]$Root, [string]$Module, [string]$ServiceId, [switch]$LegacyAdopt) {
    # Reuse needs a marker for this module and service id; a folder without a marker only for legacy adopt.
    $r = Full $Root
    if (!(Test-Path -LiteralPath $r)) {return}
    $marker = Resolve-RuntimeMarker $r $Module $ServiceId
    if ($null -ne $marker) {return}
    if ($LegacyAdopt) {return}
    if (@(Get-ChildItem -LiteralPath $r -Force).Count) {throw "Refusing ${r}: it holds runtime files without an LDA runtime marker. Use lda adopt for a legacy install, or choose an empty folder."}
}
function Write-RuntimeMarker([string]$Root, [string]$Module, [string]$ServiceId) {
    # Written to an administrators-only temp file in the same folder, flushed, then moved into place atomically,
    # so the marker is never seen half written. A leftover from an interrupted earlier write is resolved first.
    $r = Full $Root; $file = Join-Path $r $markerName
    Assert-RuntimeIdentity $r $Module $ServiceId -LegacyAdopt
    if (Test-Path -LiteralPath $file) {return}
    $json = [ordered]@{module=$Module; serviceId=$ServiceId; canonicalPath=$r; createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
    $bytes = $utf8.GetBytes($json)
    $temp = Join-Path $r ($markerName + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $stream = New-Object IO.FileStream($temp, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (New-AdminFileSecurity))
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try { Assert-SafeItem $temp; [IO.File]::Move($temp, $file) } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
    Assert-SafeItem $file
}
function Get-ServiceRoot([string]$Id) {
    $row = Get-ServiceRow $Id
    if (!$row) {return $null}
    $exe = ([string]$row.PathName).Trim('"')
    if ([string]$row.PathName -match '^"([^"]+)"') {$exe = $Matches[1]}
    return Full (Split-Path (Split-Path $exe -Parent) -Parent)
}
function Assert-NoRuntimeOverlap([string]$Root, [string]$Module) {
    # A runtime folder may not equal, contain or sit inside another module's installed or planned runtime folder.
    $r = Full $Root
    $others = New-Object 'System.Collections.Generic.List[object]'
    foreach ($key in @($Modules.Keys)) {
        if ($key -eq $Module) {continue}
        foreach ($id in @($Modules[$key].ServiceId, $Modules[$key].LegacyServiceId)) {
            $o = Get-ServiceRoot $id
            if ($o) {$others.Add(@{Module=$key; Root=$o})}
        }
    }
    if ($script:plan) {
        foreach ($op in @($script:plan.operations)) {
            if ($op.module -ne $Module -and $op.op -eq 'install') {$others.Add(@{Module=[string]$op.module; Root=(Full $op.runtimeRoot)})}
        }
    }
    foreach ($o in $others) {
        if ($r -eq $o.Root -or (Is-Within $r $o.Root) -or (Is-Within $o.Root $r)) {throw "Refusing ${r}: it overlaps the runtime folder of $($o.Module) ($($o.Root)). Each module needs its own separate folder."}
    }
}
# --- Program Files code chain: Program Files\Coding Koala\Local Developer Accelerator\<Module>\<version>. ---
function Get-CodeChain([string]$Target) {
    $programFiles = Full $env:ProgramFiles
    $full = Full $Target
    if (!(Is-Within $programFiles $full)) {throw 'Code target escaped Program Files.'}
    $folders = New-Object 'System.Collections.Generic.List[string]'
    $cursor = $full
    while ($cursor -and $cursor -ne $programFiles) { $folders.Insert(0, $cursor); $cursor = (Split-Path $cursor -Parent).TrimEnd('\') }
    return $folders.ToArray()
}
function Assert-CodeChain([string]$Target) {
    # Program Files: trusted owner. Every existing folder below it, version folders included:
    # no reparse points, trusted owner, nobody but SYSTEM/Administrators/TrustedInstaller may modify it.
    Assert-SafeItem (Full $env:ProgramFiles) -AdminOwner -OwnerOnly
    foreach ($folder in @(Get-CodeChain $Target)) {
        if (!(Test-Path -LiteralPath $folder)) {continue}
        Assert-SafeItem $folder
    }
}
function New-CodeFolder([string]$Path) {
    # Check first, then create each missing folder top-down with the code DACL and check it before its child.
    Assert-CodeChain $Path
    foreach ($folder in @(Get-CodeChain $Path)) {
        if (Test-Path -LiteralPath $folder) {continue}
        New-SecureDirectory $folder 'Code' | Out-Null
        Set-RestrictedDirectoryAcl $folder -Code  # SYSTEM/Administrators Full, Users/LocalService Read/Execute
        Assert-SafeItem $folder
    }
    Assert-CodeChain $Path
}
function Assert-TrustedExecutable([string]$Path) {
    # The file and every ancestor up to the volume root: no reparse points, owned by SYSTEM, Administrators
    # or TrustedInstaller, and nobody else may modify any of them.
    $full = Full $Path
    if (!(Test-Path -LiteralPath $full -PathType Leaf)) {throw "Executable not found: $full"}
    $volume = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    $cursor = $full
    while ($cursor -and $cursor.TrimEnd('\') -ne $volume) {
        Assert-SafeItem $cursor -AdminOwner
        $cursor = Split-Path $cursor -Parent
    }
}
function Get-NodePath {
    # Resolved once per run; the same trusted path goes into every service XML.
    if (!$script:nodePath) {
        $found = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
        if (!$found.Count) {throw 'node.exe was not found on PATH. Install Node 24 or newer into Program Files.'}
        Assert-TrustedExecutable $found[0].Source
        $script:nodePath = Full $found[0].Source
    }
    return $script:nodePath
}
function Assert-Runtime([string]$Root, [switch]$Deep) {
    $target = Full $Root
    if ($target -eq ([IO.Path]::GetPathRoot($target)).TrimEnd('\')) {throw 'Refusing a drive root.'}
    foreach ($protected in @($env:ProgramFiles, $env:SystemRoot, $env:ProgramData, $repoRoot)) {
        if (!$protected) {continue}
        $p = Full $protected
        if ($target -eq $p -or (Is-Within $target $p)) {throw "Refusing protected runtime target: $target"}
        if ($protected -ne $env:ProgramData -and (Is-Within $p $target)) {throw "Runtime cannot be inside $p"}
    }
    # The recursive reparse scan is for install/adopt/purge only; every operation checks the chain (Assert-RuntimeTree).
    Assert-NoReparse $target -Recursive:$Deep
}
function Grant-LocalServiceAccess([string]$Path, [switch]$File) {
    $a = Get-Acl -LiteralPath $Path
    $inheritance = 'ContainerInherit,ObjectInherit'; if ($File) {$inheritance='None'}
    $a.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-19')),'Modify',$inheritance,'None','Allow')))
    Set-Acl -LiteralPath $Path -AclObject $a
}
function Reset-Inheritance([string]$Path) {
    & $icaclsExe $Path /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {throw "Could not reset permissions under $Path."}
}
function Set-RuntimePermissions($Ctx) {
    # The standard policy, also applied to adopted legacy runtimes: SYSTEM/Administrators Full and LocalService
    # Modify on runtime data; service\ read-only for Users/LocalService except its logs; marker administrators only.
    Set-RestrictedDirectoryAcl $Ctx.Root
    foreach ($entry in @(Get-ChildItem -LiteralPath $Ctx.Root -Force)) {
        if ($entry.Name -in @('service', $markerName)) {continue}
        Reset-Inheritance $entry.FullName
    }
    Set-RestrictedDirectoryAcl $Ctx.Service -Service
    foreach ($entry in @(Get-ChildItem -LiteralPath $Ctx.Service -Force)) {Reset-Inheritance $entry.FullName}
    Grant-LocalServiceAccess $Ctx.Logs
    $ownLog = Join-Path $Ctx.Service "$($Ctx.Id).wrapper.log"
    if (!(Test-Path -LiteralPath $ownLog)) {[IO.File]::WriteAllText($ownLog,'',$utf8)}
    Grant-LocalServiceAccess $ownLog -File
}
function Get-ServiceRow([string]$Id) { return Get-CimInstance Win32_Service -Filter "Name='$Id'" }
function Get-Context([string]$Module, [string]$Id, [string]$Root='', [switch]$Deep) {
    $row = Get-ServiceRow $Id
    if ($row) {
        $exe = $row.PathName.Trim('"')
        if ($row.PathName -match '^"([^"]+)"') {$exe=$Matches[1]}
        $detected = Split-Path (Split-Path $exe -Parent) -Parent
        if ($Root -and (Full $Root) -ne (Full $detected)) {throw "Service $Id belongs to another runtime: $detected"}
        $Root = $detected
    }
    if (!$Root) {throw "Service $Id is not installed. Run lda install $Module."}
    Assert-Runtime $Root -Deep:$Deep
    $service = Join-Path $Root 'service'
    $ctx = @{Module=$Module; Id=$Id; Root=(Full $Root); Service=$service; Wrapper=(Join-Path $service "$Id.exe"); Xml=(Join-Path $service "$Id.xml"); Logs=(Join-Path $service 'logs'); Row=$row; Port=$Modules[$Module].Port; MemoryMb=$Modules[$Module].MemoryMb}
    if (Test-Path -LiteralPath $ctx.Xml) {
        [xml]$x = [IO.File]::ReadAllText($ctx.Xml)
        if ($x.service.id -ne $Id) {throw 'Service XML id mismatch.'}
        $ctx.Config=$x
        foreach ($e in $x.service.env) {if ($e.name -eq 'PORT') {$ctx.Port=[int]$e.value}}
        if ([string]$x.service.arguments -match '--max-old-space-size=(\d+)') {$ctx.MemoryMb=[int]$Matches[1]}
    }
    return $ctx
}
function Assert-OperationTrust($Ctx) {
    # Before the first write, ACL change or execution of every operation on an installed service.
    Assert-RuntimeTree $Ctx.Root $Ctx.Id
    Assert-NoRuntimeOverlap $Ctx.Root $Ctx.Module
    if ($Ctx.ContainsKey('Config')) { Current-Code $Ctx | Out-Null }
}
function Assert-Wrapper($Ctx) {
    if (!(Test-Path -LiteralPath $Ctx.Wrapper) -or (Hash-File $Ctx.Wrapper) -ne $wrapperSha256) {throw "WinSW SHA-256 mismatch or wrapper missing: $($Ctx.Wrapper). Remove it as Administrator and reinstall."}
}
function Invoke-Wrapper($Ctx,[string]$Action) {
    Assert-Wrapper $Ctx
    & $Ctx.Wrapper $Action 2>&1 | ForEach-Object {$result.log += "$_"}
    if ($LASTEXITCODE -ne 0) {throw "WinSW $Action failed. See $($Ctx.Logs)"}
}
function Stop-Module($Ctx) {
    $row=Get-ServiceRow $Ctx.Id
    if ($row -and $row.State -ne 'Stopped') {Stop-Service -Name $Ctx.Id; (Get-Service -Name $Ctx.Id).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
}
function Test-OwnedProcess([int]$ProcessId,[int]$ServiceProcessId) {
    if ($ServiceProcessId -le 0) {return $false}; $seen=@{}
    while ($ProcessId -gt 0 -and !$seen.ContainsKey($ProcessId)) {
        if ($ProcessId -eq $ServiceProcessId) {return $true}
        $seen[$ProcessId]=$true; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (!$p) {break}; $ProcessId=[int]$p.ParentProcessId
    }; return $false
}
function Assert-Port($Ctx) {
    $row=Get-ServiceRow $Ctx.Id; $ownerId=0; if ($row) {$ownerId=[int]$row.ProcessId}
    foreach ($l in @(Get-NetTCPConnection -State Listen -LocalPort $Ctx.Port -ErrorAction SilentlyContinue)) {
        if (!(Test-OwnedProcess ([int]$l.OwningProcess) $ownerId)) {
            $p=Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
            throw "Port $($Ctx.Port) is in use by PID $($l.OwningProcess) ($($p.ProcessName)). Use --port <free-port>."
        }
    }
}
function Wait-Healthy($Ctx,[string]$Version,[switch]$Legacy) {
    # New services must report this module and the expected version; a legacy service only has to answer /health.
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
        try {
            $h=Invoke-RestMethod -Uri "http://127.0.0.1:$($Ctx.Port)/health" -TimeoutSec 1
            $row=Get-ServiceRow $Ctx.Id
            $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Ctx.Port -ErrorAction SilentlyContinue)
            $owned=$row -and $row.State -eq 'Running' -and $listeners.Count -gt 0
            foreach ($l in $listeners) {if (!(Test-OwnedProcess ([int]$l.OwningProcess) ([int]$row.ProcessId))) {$owned=$false}}
            if ($owned -and ($Legacy -or ((Get-Field $h 'product') -eq $Ctx.Module -and (Get-Field $h 'version') -eq $Version))) {return}
        } catch {}
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($Legacy) {throw "Service $($Ctx.Id) did not answer /health in 30 seconds."}
    throw "Service did not become healthy with expected version $Version in 30 seconds. Run lda logs $($Ctx.Module)."
}
function Assert-CodeTarget([string]$Target, [switch]$Deep) {
    if (!(Is-Within $codeRoot $Target)) {throw 'Code target escaped Program Files.'}
    Assert-CodeChain $Target
    if ($Deep) {Assert-NoReparse $codeRoot -Recursive}
}
function Install-Code($Op) {
    $moduleDir=Join-Path $codeRoot $Modules[$Op.module].RuntimeFolder
    $dest=Join-Path $moduleDir $Op.version
    Assert-CodeTarget $dest -Deep
    $active=Get-ServiceRow $Modules[$Op.module].ServiceId
    if ($active) {
        $activeCtx=Get-Context $Op.module $Modules[$Op.module].ServiceId
        if ((Current-Code $activeCtx) -eq $dest) {throw "Version $($Op.version) is already active."}
    }
    New-CodeFolder $moduleDir
    $staging=Join-Path $moduleDir ('.staging-'+[Guid]::NewGuid().ToString('N'))
    New-SecureDirectory $staging 'Code' | Out-Null
    Set-RestrictedDirectoryAcl $staging -Code
    Assert-SafeItem $staging
    try {
        # Seal a copy before hashing/listing/extracting: the user cannot race the elevated reader.
        $sealed=Join-Path $staging 'release.zip'; Copy-Item -LiteralPath $Op.zip -Destination $sealed
        if ((Hash-File $sealed) -ne $Op.sha256) {throw 'Elevated release SHA-256 mismatch; no service changed.'}
        $names=@(& $tarExe -tf $sealed); if ($LASTEXITCODE -ne 0 -or !$names.Count) {throw 'Cannot list release zip.'}
        foreach ($name in $names) {
            if ($name -match '^[\\/]|^[a-zA-Z]:|:|[\x00-\x1f]' -or ($name.Replace('\','/').Split('/') -contains '..')) {throw 'Unsafe archive path.'}
            foreach ($part in $name.Replace('\','/').Split('/')) {if ($part -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {if ($part -ne '.') {throw 'Unsafe Windows archive entry.'}}}
        }
        $verbose=@(& $tarExe -tvf $sealed); if ($LASTEXITCODE -ne 0) {throw 'Cannot inspect release zip.'}
        foreach ($line in $verbose) {if ($line -notmatch '^[-d]' -or $line -match ' -> | link to ') {throw 'Archive links and special files are forbidden.'}}
        $unpack=Join-Path $staging 'code'; New-SecureDirectory $unpack 'Code' | Out-Null
        & $tarExe -xf $sealed -C $unpack; if ($LASTEXITCODE -ne 0) {throw 'Release extraction failed.'}
        Assert-NoReparse $unpack -Recursive
        foreach ($required in @('src\server.js','scripts\service-xml.js')) {if (!(Test-Path -LiteralPath (Join-Path $unpack $required) -PathType Leaf)) {throw "Release is missing $required"}}
        Assert-CodeTarget $dest
        # Reusing a retained version after rollback still extracts verified bytes anew.
        if (Test-Path -LiteralPath $dest) {Remove-Code $dest}
        Move-Item -LiteralPath $unpack -Destination $dest
        Set-RestrictedDirectoryAcl $dest -Code
        Assert-CodeTarget $dest
    } finally {
        if ((Is-Within $moduleDir $staging) -and (Test-Path -LiteralPath $staging)) {Assert-NoReparse $staging -Recursive; Remove-Item -LiteralPath $staging -Recurse -Force}
    }
    return $dest
}
function Assert-CodeFiles([string]$Code) {
    # The files the service and this helper execute or load, and the folders holding them: nobody but
    # SYSTEM, Administrators and TrustedInstaller may modify them. package.json is checked when present.
    foreach ($rel in @('src', 'scripts', 'src\server.js', 'scripts\service-xml.js', 'package.json')) {
        $p=Join-Path $Code $rel
        if (!(Test-Path -LiteralPath $p)) {if ($rel -eq 'package.json') {continue}; throw "Refusing to run the code in ${Code}: $rel is missing. Reinstall the module."}
        Assert-SafeItem $p
    }
    Assert-CodeTree $Code
}
function Assert-CodeTree([string]$Code) {
    # The whole version folder (every file and folder, node_modules included), in one recursive pass: no reparse
    # points, a trusted owner and no untrusted principal able to modify anything the service may load. Items with
    # an identical owner and DACL (usually inherited) are checked once, keyed by their SDDL.
    $owners = @($adminSids) + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
    $trusted = @{}
    $check = {
        param($Item)
        if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {throw "Refusing to run the code in ${Code}: $($Item.FullName) is a junction or symbolic link. Reinstall the module."}
        $acl = $Item.GetAccessControl($sections)
        $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
        if ($trusted.ContainsKey($sddl)) {return}
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin $owners) {throw "Refusing to run the code in ${Code}: $($Item.FullName) is owned by $(Get-PrincipalName $owner). Reinstall the module."}
        $writer = Find-UntrustedWriter $acl
        if ($writer) {throw "Refusing to run the code in ${Code}: $(Get-PrincipalName $writer) can modify $($Item.FullName). Reinstall the module."}
        $trusted[$sddl] = $true
    }
    & $check (Get-Item -LiteralPath $Code -Force)
    Get-ChildItem -LiteralPath $Code -Recurse -Force | ForEach-Object { & $check $_ }
}
function Assert-ServiceNode($Ctx) {
    # The Node executable named in an existing service XML gets the same full-chain trust check as a newly
    # selected one before the service is started, restarted, upgraded or rolled back.
    $exe=''
    try {
        $exe=[string]$Ctx.Config.service.executable
        if (!$exe -or ![IO.Path]::IsPathRooted($exe)) {throw 'it is not an absolute path'}
        Assert-TrustedExecutable $exe
    } catch {
        throw "Refusing to run $($Ctx.Id): its service uses the Node executable '$exe', which is not safe to run as a service ($($_.Exception.Message)). Install Node 24 or newer system-wide (into Program Files), then reinstall the module (lda uninstall $($Ctx.Module), then lda install $($Ctx.Module); your data is kept)."
    }
}
function Invoke-ModuleNode([string]$Code,[string]$Action,$Options) {
    Assert-CodeFiles $Code
    $nodePath=Get-NodePath
    $previous=[Console]::OutputEncoding
    try {
        [Console]::OutputEncoding=$utf8
        $output=@(($Options | ConvertTo-Json -Compress) | & $nodePath (Join-Path $Code 'scripts\service-xml.js') $Action)
        if ($LASTEXITCODE -ne 0) {throw "Module service-xml.js $Action failed."}
        return ($output -join [Environment]::NewLine)
    } finally {[Console]::OutputEncoding=$previous}
}
function Install-Module($Op,[string]$Code,[switch]$Adopting) {
    $mod=$Modules[$Op.module]; $ctx=Get-Context $Op.module $mod.ServiceId $Op.runtimeRoot -Deep
    if ($ctx.Row) {throw 'Service already installed. Use lda upgrade.'}
    $ctx.Port=[int]$Op.port; $ctx.MemoryMb=[int](Get-Field $Op 'memoryMb' $mod.MemoryMb)
    Assert-RuntimeTree $ctx.Root $ctx.Id
    Assert-NoRuntimeOverlap $ctx.Root $Op.module
    Assert-RuntimeIdentity $ctx.Root $Op.module $ctx.Id -LegacyAdopt:$Adopting
    Assert-Port $ctx
    $nodePath=Get-NodePath
    if (Test-Path -LiteralPath $ctx.Wrapper) {Assert-Wrapper $ctx}
    $options=@{nodePath=$nodePath; repoRoot=$Code; runtimeRoot=$ctx.Root; port=$ctx.Port}
    if ($mod.MemoryMb -gt 0) {$options.maxMemoryMB=$ctx.MemoryMb}
    $generated=Invoke-ModuleNode $Code 'xml' $options
    [xml]$x=$generated
    if ($x.service.id -ne $ctx.Id) {throw 'Module generated the wrong service id.'}
    New-RuntimeRoot $ctx.Root
    Set-RestrictedDirectoryAcl $ctx.Root
    # The marker comes first, so an interrupted install leaves a folder a retry recognises as its own.
    Write-RuntimeMarker $ctx.Root $Op.module $ctx.Id
    New-RuntimeFolders $ctx
    Set-RuntimePermissions $ctx
    Assert-RuntimeTree $ctx.Root $ctx.Id
    # DACL is already exact before any tenant credentials are generated. Preserve existing tenants.
    if (!(Test-Path -LiteralPath (Join-Path $ctx.Root 'tenants.json'))) {Invoke-ModuleNode $Code 'init' $options | Out-Null}
    if (!(Test-Path -LiteralPath $ctx.Wrapper)) {
        [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $download=$ctx.Wrapper+'.download'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $wrapperUrl -OutFile $download
            if ((Hash-File $download) -ne $wrapperSha256) {throw 'WinSW download SHA-256 mismatch.'}
            Move-Item -LiteralPath $download -Destination $ctx.Wrapper
        } finally {if (Test-Path -LiteralPath $download) {Remove-Item -LiteralPath $download -Force}}
    }
    Assert-Wrapper $ctx
    [IO.File]::WriteAllText($ctx.Xml,$generated,$utf8)
    Set-RuntimePermissions $ctx
    Assert-RuntimeTree $ctx.Root $ctx.Id
    Invoke-Wrapper $ctx 'install'
    & $scExe config $ctx.Id start= delayed-auto obj= 'NT AUTHORITY\LocalService' | Out-Null
    if ($LASTEXITCODE -ne 0) {throw 'Could not set service account/startup.'}
    & $scExe failure $ctx.Id reset= 3600 actions= restart/10000/restart/10000/restart/10000 | Out-Null
    if ($LASTEXITCODE -ne 0) {throw 'Could not set service recovery.'}
    Assert-Port $ctx; Invoke-Wrapper $ctx 'start'; Wait-Healthy $ctx $Op.version
}
function Current-Code($Ctx) {
    $code=[string]$Ctx.Config.service.workingdirectory
    Assert-CodeTarget $code
    $moduleDir=Join-Path $codeRoot $Modules[$Ctx.Module].RuntimeFolder
    if ((Full (Split-Path $code -Parent)) -ne (Full $moduleDir)) {throw 'Service code belongs to another module.'}
    return $code
}
function Switch-Code($Ctx,[string]$Code,[string]$Version) {
    # What recovery achieved, read by the caller before it deletes a failed candidate.
    $script:switchRecovery=@{XmlWritten=$false; FailedStopped=$false; XmlRestored=$false; OldHealthy=$false}
    $old=[IO.File]::ReadAllText($Ctx.Xml); $oldCode=Current-Code $Ctx; $oldVersion=Split-Path $oldCode -Leaf
    Assert-CodeTarget $Code
    [xml]$x=$old
    $server=Join-Path $Code 'src\server.js'
    $oldServer=Join-Path $oldCode 'src\server.js'
    if (!([string]$x.service.arguments).Contains($oldServer)) {throw 'Cannot locate server path in service XML.'}
    $x.service.arguments=([string]$x.service.arguments).Replace($oldServer,$server)
    $x.service.workingdirectory=$Code
    Assert-Port $Ctx; Stop-Module $Ctx
    try {
        $script:switchRecovery.XmlWritten=$true; $x.Save($Ctx.Xml); Assert-Port $Ctx; Invoke-Wrapper $Ctx 'start'; Wait-Healthy $Ctx $Version
    } catch {
        # Each recovery step is attempted on its own and reported; the original failure stays the primary error.
        $failure=$_.Exception.Message
        $steps=New-Object 'Collections.Generic.List[string]'
        try {Stop-Module $Ctx; $script:switchRecovery.FailedStopped=$true; $steps.Add('Stopped the failed version.')} catch {$steps.Add("Could not stop the failed version: $($_.Exception.Message)")}
        $restored=$false
        try {[IO.File]::WriteAllText($Ctx.Xml,$old,$utf8); $restored=$true; $script:switchRecovery.XmlRestored=$true; $steps.Add('Restored the previous service XML.')} catch {$steps.Add("Could not restore the previous service XML: $($_.Exception.Message)")}
        $healthy=$false
        if ($restored) {
            try {Invoke-Wrapper $Ctx 'start'; $steps.Add("Started version $oldVersion again.")} catch {$steps.Add("Could not start version ${oldVersion}: $($_.Exception.Message)")}
            try {Wait-Healthy $Ctx $oldVersion; $healthy=$true; $script:switchRecovery.OldHealthy=$true; $steps.Add("Version $oldVersion answered /health.")} catch {$steps.Add("Version $oldVersion is NOT healthy: $($_.Exception.Message)")}
        } else {$steps.Add('Did not start the service, because the previous XML was not restored.')}
        foreach ($s in $steps) {$result.log+="Recovery: $s"}
        if ($healthy) {throw "Upgrade/rollback failed: $failure The previous XML restored; version $oldVersion is running and healthy."}
        if ($restored) {throw "Upgrade/rollback failed: $failure The previous XML restored, but version $oldVersion is not healthy. Run lda logs $($Ctx.Module)."}
        throw "Upgrade/rollback failed: $failure The previous XML could not be restored. Run lda doctor."
    }
}
function Remove-Code([string]$Target) {
    Assert-CodeTarget $Target -Deep
    $resolved=(Resolve-Path -LiteralPath $Target).ProviderPath
    if ((Full $resolved) -ne (Full $Target)) {throw 'Code path resolution changed.'}
    Assert-NoReparse $resolved -Recursive
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
function Compare-ReleaseVersion([string]$Left,[string]$Right) {
    $a=$Left -split '-',2; $b=$Right -split '-',2
    $core=([version]$a[0]).CompareTo([version]$b[0]); if ($core -ne 0) {return $core}
    if ($a.Count -eq 1 -or $b.Count -eq 1) {if ($a.Count -eq $b.Count) {return 0}; if ($a.Count -eq 1) {return 1}; return -1}
    $ap=$a[1].Split('.'); $bp=$b[1].Split('.')
    for ($i=0; $i -lt [Math]::Max($ap.Count,$bp.Count); $i++) {
        if ($i -ge $ap.Count) {return -1}; if ($i -ge $bp.Count) {return 1}
        if ($ap[$i] -ceq $bp[$i]) {continue}
        $an=$ap[$i] -match '^\d+$'; $bn=$bp[$i] -match '^\d+$'
        if ($an -and $bn) {
            $x=$ap[$i].TrimStart('0'); $y=$bp[$i].TrimStart('0')
            if ($x.Length -ne $y.Length) {return $x.Length.CompareTo($y.Length)}
            $c=[string]::CompareOrdinal($x,$y); if ($c -ne 0) {return $c}; continue
        }
        if ($an -ne $bn) {if ($an) {return -1}; return 1}
        return [string]::CompareOrdinal($ap[$i],$bp[$i])
    }
    return 0
}
function Get-VersionFolders([string]$Dir) {
    # Version folders, newest first by semver.
    $versions=New-Object 'Collections.Generic.List[IO.DirectoryInfo]'
    if (!(Test-Path -LiteralPath $Dir)) {return ,$versions}
    foreach ($entry in Get-ChildItem -LiteralPath $Dir -Directory) {if ($entry.Name -match $versionPattern) {$versions.Add($entry)}}
    $versions.Sort([Comparison[IO.DirectoryInfo]]{param($a,$b) return -(Compare-ReleaseVersion $a.Name $b.Name)})
    return ,$versions
}
# --- Committed versions: <module code folder>\versions.json {current, previous, committedAt}. ---
function Get-VersionsFile([string]$Module) { return Join-Path (Join-Path $codeRoot $Modules[$Module].RuntimeFolder) 'versions.json' }
function Set-CommittedVersions([string]$Module,[string]$Current,[string]$Previous) {
    # Written only after a healthy install/adopt/upgrade/rollback; atomically (flushed temp file, then replace).
    $file=Get-VersionsFile $Module; $dir=Split-Path $file -Parent
    if ((Test-Path -LiteralPath $file) -and (Test-ReparsePoint $file)) {throw "Refusing reparse point: $file"}
    $prev=$null; if ($Previous) {$prev=$Previous}
    $json=[ordered]@{current=$Current; previous=$prev; committedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
    $bytes=$utf8.GetBytes($json)
    $temp=Join-Path $dir ('versions.json.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)} finally {$stream.Dispose()}
    try {
        if (Test-Path -LiteralPath $file) {[IO.File]::Replace($temp,$file,[NullString]::Value)} else {[IO.File]::Move($temp,$file)}
    } finally {if (Test-Path -LiteralPath $temp) {Remove-Item -LiteralPath $temp -Force}}
}
function Get-CommittedVersions([string]$Module,[string]$Active) {
    # Trusted only when its current version is the version folder the active service XML points at,
    # and previous is a different, existing version folder. Otherwise there is no rollback target.
    $file=Get-VersionsFile $Module; $dir=Split-Path $file -Parent
    $none=@{current=$Active; previous=$null}
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Test-ReparsePoint $file)) {return $none}
    try {$data=[IO.File]::ReadAllText($file) | ConvertFrom-Json} catch {return $none}
    $current=[string](Get-Field $data 'current' ''); $previous=[string](Get-Field $data 'previous' '')
    if ($current -cne $Active) {$result.log+="versions.json records $current, but version $Active is active; no rollback target is trusted."; return $none}
    if ($previous -notmatch $versionPattern -or $previous -ceq $current -or !(Test-Path -LiteralPath (Join-Path $dir $previous) -PathType Container)) {return $none}
    return @{current=$current; previous=$previous}
}
function Prune-Versions([string]$Module,[string]$Current,[string]$Previous) {
    # Keep exactly the committed current and previous version folders.
    $dir=Join-Path $codeRoot $Modules[$Module].RuntimeFolder
    foreach ($entry in (Get-VersionFolders $dir)) {
        if ($entry.Name -ne $Current -and $entry.Name -ne $Previous) {Remove-Code $entry.FullName}
    }
}
function Test-CandidateReleased($Ctx,[string]$Code,$Recovery) {
    # A failed candidate may be deleted only when nothing can still use it: the service XML on disk no longer
    # names it, and either the switch never wrote the XML, or recovery restored the previous XML and the service
    # is stopped or confirmed running the previous version. Any doubt keeps the candidate.
    if ($null -eq $Recovery) {return $false}
    try {
        [xml]$x=[IO.File]::ReadAllText($Ctx.Xml)
        $named=([string]$x.service.workingdirectory) + ' ' + ([string]$x.service.arguments)
        if ($named.IndexOf((Full $Code),[StringComparison]::OrdinalIgnoreCase) -ge 0) {return $false}
        if (!$Recovery.XmlWritten) {return $true}
        if (!$Recovery.XmlRestored) {return $false}
        if ($Recovery.OldHealthy) {return $true}
        $state=[string](Get-Field (Get-ServiceRow $Ctx.Id) 'State' '')
        return ($state -eq 'Stopped')
    } catch {return $false}
}
function Remove-Candidate([string]$Code,[string]$Current,[string]$Previous) {
    # A failed upgrade deletes only its own extracted folder, never the current or committed previous version.
    $version=Split-Path $Code -Leaf
    if ($version -eq $Current -or ($Previous -and $version -eq $Previous)) {$result.log+="Kept $Code because it is a committed version."; return}
    try {Remove-Code $Code; $result.log+="Removed the failed candidate $Code."} catch {$result.log+="Could not remove the failed candidate ${Code}: $($_.Exception.Message)"}
}
function Assert-SafeRemoval($Ctx) {
    Assert-Runtime $Ctx.Root -Deep
    Assert-RuntimeTree $Ctx.Root $Ctx.Id
    Assert-RuntimeLayout $Ctx.Root
    if (!(Test-Path -LiteralPath $Ctx.Xml)) {throw 'Refusing purge without generated service XML.'}
    [xml]$x=[IO.File]::ReadAllText($Ctx.Xml)
    if ($x.service.id -ne $Ctx.Id) {throw 'Refusing purge: service XML id mismatch.'}
    $marker=Get-RuntimeMarker $Ctx.Root
    $canonical=''; if ($null -ne $marker) {$canonical=[string](Get-Field $marker 'canonicalPath' '')}
    if ($null -eq $marker -or [string](Get-Field $marker 'module' '') -ne $Ctx.Module -or !$canonical -or (Full $canonical) -ne (Full $Ctx.Root)) {throw "Refusing purge: $($Ctx.Root) has no LDA runtime marker for $($Ctx.Module) at this path. The service was not changed; delete the folder yourself if you are sure."}
    $resolved=(Resolve-Path -LiteralPath $Ctx.Root).ProviderPath
    if ((Full $resolved) -ne (Full $Ctx.Root)) {throw 'Runtime path resolution changed.'}
    Assert-NoReparse $resolved -Recursive
}
# --- Adopt: the legacy registration stays until the new service is healthy and committed. ---
function Get-SecuritySnapshot([string]$Path) {
    # Owner and DACL as SDDL, taken before adoption changes any permission.
    if (!(Test-Path -LiteralPath $Path)) {return $null}
    return @{Path=(Full $Path); Sddl=(Get-Acl -LiteralPath $Path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access, Owner')}
}
function Restore-SecuritySnapshot($Snapshot) {
    # Puts back the DACL and owner; when the owner cannot be set, the DACL alone is restored and that is reported.
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetSecurityDescriptorSddlForm($Snapshot.Sddl,[Security.AccessControl.AccessControlSections]'Access, Owner')
    # SetAccessControl writes only the sections taken from the SDDL (Set-Acl would also try to write the SACL).
    $item=Get-Item -LiteralPath $Snapshot.Path -Force
    try {$item.SetAccessControl($acl); return "Restored the original permissions of $($Snapshot.Path)."} catch {
        $ownerFailure=$_.Exception.Message
        $dacl=New-Object Security.AccessControl.DirectorySecurity
        $dacl.SetSecurityDescriptorSddlForm($Snapshot.Sddl,[Security.AccessControl.AccessControlSections]::Access)
        $item.SetAccessControl($dacl)
        return "Restored the original permissions of $($Snapshot.Path), but not its original owner ($ownerFailure)."
    }
}
function Undo-Adopt($Legacy,$Mod,[string]$Code,[bool]$WasRunning,[bool]$StopRequested,$Snapshots=@()) {
    # Each step runs on its own and reports its own outcome. The legacy registration (and its service
    # account) was never touched; the new service, the staged code and the runtime permissions are undone.
    $steps=New-Object 'Collections.Generic.List[string]'
    $newId=$Mod.ServiceId
    $newCtx=@{Id=$newId; Wrapper=(Join-Path $Legacy.Service "$newId.exe"); Xml=(Join-Path $Legacy.Service "$newId.xml"); Logs=$Legacy.Logs}
    if (Get-ServiceRow $newId) {
        try {Stop-Module $newCtx; $steps.Add("Stopped the new service $newId.")} catch {$steps.Add("Could not stop the new service ${newId}: $($_.Exception.Message)")}
        try {Invoke-Wrapper $newCtx 'uninstall'; $steps.Add("Removed the new service $newId.")} catch {
            $steps.Add("Could not remove the new service ${newId}: $($_.Exception.Message) Remove it as Administrator.")
            # Never leave two registrations that both start at boot.
            $disabled=$false
            try {& $scExe config $newId start= disabled | Out-Null; $disabled=($LASTEXITCODE -eq 0)} catch {}
            if ($disabled) {$steps.Add("Set the new service $newId to disabled so it does not start at boot.")}
            else {$steps.Add("Could not disable the new service $newId either; disable or remove it as Administrator before restarting Windows.")}
        }
    }
    foreach ($file in @($newCtx.Wrapper,$newCtx.Xml)) {
        try {if (Test-Path -LiteralPath $file) {Remove-Item -LiteralPath $file -Force}} catch {$steps.Add("Could not delete ${file}: $($_.Exception.Message)")}
    }
    try {Remove-Code $Code; $steps.Add("Removed the staged code $Code.")} catch {$steps.Add("Could not remove the staged code ${Code}: $($_.Exception.Message)")}
    foreach ($snapshot in @($Snapshots)) {
        if ($null -eq $snapshot) {continue}
        try {$steps.Add((Restore-SecuritySnapshot $snapshot))} catch {$steps.Add("Could not restore the original permissions of $($snapshot.Path): $($_.Exception.Message)")}
    }
    if (!$StopRequested) {$steps.Add("Legacy service $($Legacy.Id) was not stopped.")}
    elseif (!$WasRunning) {$steps.Add("Legacy service $($Legacy.Id) was stopped before adoption and was left stopped.")}
    else {
        # A stop was requested (even if waiting for it timed out), so the legacy service is started again.
        $started=$false
        try {Assert-Port $Legacy; Invoke-Wrapper $Legacy 'start'; $started=$true} catch {$steps.Add("Could not start legacy service $($Legacy.Id): $($_.Exception.Message)")}
        if ($started) {
            try {Wait-Healthy $Legacy '' -Legacy; $steps.Add("Legacy service $($Legacy.Id) is running again and answered /health.")}
            catch {$steps.Add("Legacy service $($Legacy.Id) was started but could NOT be confirmed healthy: $($_.Exception.Message)")}
        }
    }
    foreach ($s in $steps) {$result.log+="Recovery: $s"}
    return $steps.ToArray()
}
function Remove-LegacyService($Legacy,$Mod) {
    # Only after the new service passed its health check and versions.json was committed: unregister the legacy
    # id, back up its wrapper files under backups\, then delete them. Two registrations never both start at boot.
    try {Invoke-Wrapper $Legacy 'uninstall'} catch {
        $failure=$_.Exception.Message
        $disabled=$false; try {& $scExe config $Legacy.Id start= disabled | Out-Null; $disabled=($LASTEXITCODE -eq 0)} catch {}
        if ($disabled) {throw "The new service is healthy, but legacy service $($Legacy.Id) could not be unregistered ($failure); it was set to disabled. Remove it as Administrator."}
        $manual=$false; if ($Mod) {try {& $scExe config $Mod.ServiceId start= demand | Out-Null; $manual=($LASTEXITCODE -eq 0)} catch {}}
        if ($manual) {throw "The new service is healthy, but legacy service $($Legacy.Id) could not be unregistered ($failure) or disabled. The new service $($Mod.ServiceId) was set to manual start so only one of them starts at boot. Remove the legacy service as Administrator, then set $($Mod.ServiceId) back to automatic start (sc config $($Mod.ServiceId) start= delayed-auto)."}
        throw "The new service is healthy, but legacy service $($Legacy.Id) could not be unregistered ($failure) or disabled, and the new service could not be set to manual start. Both may start at boot: remove or disable $($Legacy.Id) as Administrator now."
    }
    $files=@(Get-ChildItem -LiteralPath $Legacy.Service -File -Force | Where-Object {$_.Name.StartsWith($Legacy.Id+'.',[StringComparison]::OrdinalIgnoreCase)})
    if (!$files.Count) {return}
    $backups=Join-Path $Legacy.Root 'backups'
    New-SecureDirectory $backups 'Runtime' | Out-Null
    Assert-SafeItem $backups -AllowLocalService
    $target=Join-Path $backups ("adopt-$($Legacy.Id)-" + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))
    New-SecureDirectory $target 'Admin' | Out-Null
    Assert-SafeItem $target
    foreach ($entry in $files) {Assert-NoReparse $entry.FullName; Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $target $entry.Name)}
    foreach ($entry in $files) {Remove-Item -LiteralPath $entry.FullName -Force}
    $result.log+="Legacy wrapper files were backed up to $target and removed."
}
function Invoke-Adopt($Op) {
    $mod=$Modules[$Op.module]
    if (Get-ServiceRow $mod.ServiceId) {throw 'New service already exists; refusing to replace it.'}
    $legacy=Get-Context $Op.module $Op.legacyServiceId -Deep
    if (!$legacy.ContainsKey('Config')) {throw 'Legacy service XML is required.'}
    # Every check precedes the first change. Only a LocalService legacy service is adopted: adoption gives the
    # runtime folder the LocalService permission policy, which could cut any other account off from its data.
    $account=[string](Get-Field $legacy.Row 'StartName' '')
    $accountSid=''; try {$accountSid=(New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value} catch {}
    if ($accountSid -ne $localServiceSid -and $account -notin @('NT AUTHORITY\LocalService','NT AUTHORITY\LOCAL SERVICE')) {
        throw "Refusing to adopt: legacy service $($legacy.Id) runs as '$account', not NT AUTHORITY\LocalService. The new service runs as LocalService and adoption sets the data folder permissions for LocalService, so the legacy account could lose access to its own data. Switch the legacy service to LocalService first (sc config $($legacy.Id) obj= `"NT AUTHORITY\LocalService`"), check it still starts, then retry. Nothing was changed."
    }
    Assert-RuntimeTree $legacy.Root $legacy.Id
    Assert-NoRuntimeOverlap $legacy.Root $Op.module
    Assert-RuntimeIdentity $legacy.Root $Op.module $mod.ServiceId -LegacyAdopt
    Assert-Wrapper $legacy; Assert-Port $legacy
    $newWrapper=Join-Path $legacy.Service "$($mod.ServiceId).exe"; $newXml=Join-Path $legacy.Service "$($mod.ServiceId).xml"
    foreach ($file in @($newWrapper,$newXml)) {if (Test-Path -LiteralPath $file) {throw "Refusing to adopt: $file already exists. Remove it as Administrator and retry."}}
    $wasRunning=([string](Get-Field $legacy.Row 'State' '') -eq 'Running')
    # Permissions as they are now, restored if adoption fails after the runtime ACLs were reset.
    $snapshots=@(@((Get-SecuritySnapshot $legacy.Root), (Get-SecuritySnapshot $legacy.Service)) | Where-Object {$null -ne $_})
    $code=Install-Code $Op
    $stopRequested=$false
    try {
        # Recorded before the call: a stop that times out was still requested, so recovery restarts the legacy service.
        $stopRequested=$true; Stop-Module $legacy
        # Reuse the pinned legacy wrapper instead of downloading one.
        Copy-Item -LiteralPath $legacy.Wrapper -Destination $newWrapper
        if ((Hash-File $newWrapper) -ne $wrapperSha256) {throw 'Legacy wrapper does not match the pinned WinSW SHA-256.'}
        $install=[pscustomobject]@{op='install'; module=$Op.module; version=$Op.version; runtimeRoot=$legacy.Root; port=$legacy.Port; memoryMb=$legacy.MemoryMb}
        Install-Module $install $code -Adopting
        # Committing the version record is part of the transaction: if it fails, everything above is undone.
        Set-CommittedVersions $Op.module $Op.version ''
    } catch {
        $failure=$_.Exception.Message
        $steps=Undo-Adopt $legacy $mod $code $wasRunning $stopRequested $snapshots
        throw "Adoption failed: $failure Recovery: $($steps -join ' ')"
    }
    Remove-LegacyService $legacy $mod
}
function Write-VersionRecord([string]$Module,[string]$Current,[string]$Previous) {
    # After a successful switch the service already runs $Current; a failed record write is reported plainly and
    # nothing is pruned. The old record no longer matches the active version, so no rollback target is trusted.
    try {Set-CommittedVersions $Module $Current $Previous} catch {
        $message="Service switched to $Current but version record could not be written; rollback unavailable until next successful upgrade. ($($_.Exception.Message))"
        $result.log+=$message
        throw $message
    }
}
function Invoke-Operation($Op) {
    $mod=$Modules[$Op.module]
    if ($Op.op -eq 'install') {
        if (Get-ServiceRow $mod.LegacyServiceId) {throw "Legacy install found. Run lda adopt $($Op.module)."}
        # Ownership/rights/identity/runtime/port checks precede extracting code or changing anything.
        Assert-RuntimeChain $Op.runtimeRoot
        Assert-RuntimeLayout $Op.runtimeRoot
        $ctx=Get-Context $Op.module $mod.ServiceId $Op.runtimeRoot -Deep
        if ($ctx.Row) {throw 'Service already installed. Use lda upgrade.'}
        Assert-RuntimeTree $ctx.Root $ctx.Id
        Assert-NoRuntimeOverlap $ctx.Root $Op.module
        Assert-RuntimeIdentity $ctx.Root $Op.module $ctx.Id
        $ctx.Port=[int]$Op.port; Assert-Port $ctx
        if (Test-Path -LiteralPath $ctx.Wrapper) {Assert-Wrapper $ctx}
        $code=Install-Code $Op; Install-Module $Op $code
        Write-VersionRecord $Op.module $Op.version ''
        return
    }
    if ($Op.op -eq 'adopt') {Invoke-Adopt $Op; return}
    $ctx=Get-Context $Op.module $mod.ServiceId -Deep:($Op.op -eq 'uninstall' -and $Op.purge)
    if (!$ctx.Row) {throw 'Service is not installed.'}
    Assert-OperationTrust $ctx
    Assert-Wrapper $ctx
    if ($Op.op -in @('start','restart','upgrade','rollback')) {
        # Whatever the service will run: the Node executable in its XML and the active version's files.
        Assert-ServiceNode $ctx
        Assert-CodeFiles (Current-Code $ctx)
    }
    switch ($Op.op) {
        'upgrade' {
            $current=Current-Code $ctx; $currentVersion=Split-Path $current -Leaf
            $committed=Get-CommittedVersions $Op.module $currentVersion
            $code=Install-Code $Op
            Assert-CodeFiles $code
            $script:switchRecovery=$null
            try {Switch-Code $ctx $code $Op.version} catch {
                $failure=$_.Exception.Message
                # Only a candidate nothing can still use is deleted; otherwise it is kept and reported.
                if (Test-CandidateReleased $ctx $code $script:switchRecovery) {Remove-Candidate $code $currentVersion $committed.previous; throw}
                $result.log+="Kept the candidate $code because recovery did not complete."
                throw "$failure Candidate kept because recovery did not complete: $code"
            }
            Write-VersionRecord $Op.module $Op.version $currentVersion
            Prune-Versions $Op.module $Op.version $currentVersion
        }
        'rollback' {
            $current=Current-Code $ctx; $currentVersion=Split-Path $current -Leaf
            $committed=Get-CommittedVersions $Op.module $currentVersion
            if (!$committed.previous) {throw 'No committed previous version is available to roll back to.'}
            $target=Join-Path (Split-Path $current -Parent) $committed.previous
            Assert-CodeFiles $target
            Switch-Code $ctx $target $committed.previous
            # Rolling back again returns to the version just left.
            Write-VersionRecord $Op.module $committed.previous $currentVersion
        }
        'uninstall' {
            if ($Op.purge) {Assert-SafeRemoval $ctx}
            $code=Current-Code $ctx; $dir=Split-Path $code -Parent
            Stop-Module $ctx; Invoke-Wrapper $ctx 'uninstall'
            if (Test-Path -LiteralPath $dir) {Remove-Code $dir}
            if ($Op.purge) {Assert-SafeRemoval $ctx; Remove-Item -LiteralPath (Full $ctx.Root) -Recurse -Force}
        }
        'stop' {Stop-Module $ctx}
        'start' {Assert-Port $ctx; Invoke-Wrapper $ctx 'start'; Wait-Healthy $ctx (Split-Path (Current-Code $ctx) -Leaf)}
        'restart' {Assert-Port $ctx; Stop-Module $ctx; Assert-Port $ctx; Invoke-Wrapper $ctx 'start'; Wait-Healthy $ctx (Split-Path (Current-Code $ctx) -Leaf)}
    }
}
function Validate-Plan($Plan) {
    if ($Plan.version -ne 1 -or !$Plan.createdAt -or !$Plan.operations -or @($Plan.operations).Count -gt $Modules.Count) {throw 'Invalid plan envelope.'}
    $fields=@{install=@('op','module','version','zip','sha256','port','runtimeRoot','memoryMb'); upgrade=@('op','module','version','zip','sha256'); adopt=@('op','module','legacyServiceId','version','zip','sha256'); rollback=@('op','module'); uninstall=@('op','module','purge'); start=@('op','module'); stop=@('op','module'); restart=@('op','module')}
    $seen=@{}
    foreach ($o in $Plan.operations) {
        if (!$Modules.ContainsKey([string]$o.module) -or !$fields.ContainsKey([string]$o.op)) {throw 'Unknown module or operation.'}
        if ($seen.ContainsKey($o.module)) {throw 'Duplicate module operation.'}; $seen[$o.module]=$true
        foreach ($p in $o.PSObject.Properties.Name) {if ($p -notin $fields[$o.op]) {throw "Unexpected operation field: $p"}}
        if ($o.op -in @('install','upgrade','adopt')) {
            if ($o.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$' -or $o.sha256 -notmatch '^[a-fA-F0-9]{64}$') {throw 'Invalid version or SHA-256.'}
            if ($o.zip -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or !(Is-Within $cacheRoot $o.zip) -or [IO.Path]::GetExtension($o.zip) -ne '.zip') {throw 'Zip must be under the user cache folder.'}
        }
        if ($o.op -eq 'install') {
            if ($o.port -isnot [int] -or $o.port -lt 1 -or $o.port -gt 65535) {throw 'Port must be an integer from 1 to 65535.'}
            if ($o.runtimeRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $o.runtimeRoot -match '[\x00-\x1f"%]') {throw 'Data directory must be absolute without quotes, control characters or %.'}
            $memory=Get-Field $o 'memoryMb'
            if ($null -ne $memory -and ($Modules[$o.module].MemoryMb -eq 0 -or $memory -isnot [int] -or $memory -lt 1024 -or $memory -gt 65536)) {throw 'Invalid memoryMb.'}
        }
        if ($o.op -eq 'adopt' -and $o.legacyServiceId -ne $Modules[$o.module].LegacyServiceId) {throw 'Invalid legacy service id.'}
        if ($o.op -eq 'uninstall' -and $o.purge -isnot [bool]) {throw 'purge must be boolean.'}
    }
    $installs=@($Plan.operations | Where-Object {$_.op -eq 'install'})
    for ($i=0; $i -lt $installs.Count; $i++) {for ($j=$i+1; $j -lt $installs.Count; $j++) {
        $a=Full $installs[$i].runtimeRoot; $b=Full $installs[$j].runtimeRoot
        if ($a -eq $b -or (Is-Within $a $b) -or (Is-Within $b $a)) {throw 'Each module needs its own separate data directory.'}
    }}
}
function Get-FinalPath($Handle) {
    if (-not ('LdaFinalPath' -as [type])) {
        Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class LdaFinalPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
}
'@
    }
    $buffer=New-Object Text.StringBuilder 2048
    $length=[LdaFinalPath]::GetFinalPathNameByHandle($Handle,$buffer,2048,0)
    if ($length -eq 0 -or $length -ge 2048) {throw 'Cannot resolve the result file path.'}
    $path=$buffer.ToString()
    if ($path.StartsWith('\\?\UNC\')) {$path='\\'+$path.Substring(8)} elseif ($path.StartsWith('\\?\')) {$path=$path.Substring(4)}
    return Full $path
}
function Open-ResultFile([string]$Path) {
    # Create the result file exclusively, before any service change, and keep the handle:
    # a file planted later, a junction or a swapped plans folder cannot redirect this write.
    $full=Full $Path
    Assert-NoReparse $plansRoot
    $stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $final=Get-FinalPath $stream.SafeFileHandle
        if (!$final.Equals($full,[StringComparison]::OrdinalIgnoreCase)) {throw "Result file resolved to $final instead of $full."}
        if (Test-ReparsePoint $full) {throw "Refusing reparse point: $full"}
        Assert-NoReparse (Split-Path $full -Parent)
    } catch {$stream.Dispose(); throw}
    return $stream
}
function Write-Result($Stream) {
    try {
        $bytes=$utf8.GetBytes(($result | ConvertTo-Json -Depth 8))
        $Stream.SetLength(0); $Stream.Write($bytes,0,$bytes.Length); $Stream.Flush()
    } finally {$Stream.Dispose()}
}
$exitCode=1
try {
    if (!$DryRun) {
        if (!$ResultFile -or !(Is-Within $plansRoot $ResultFile) -or !(Is-Within $plansRoot $PlanFile)) {throw 'Plan and result files must be in the user plans folder.'}
        Assert-NoReparse $plansRoot -Recursive
        $resultStream=Open-ResultFile $ResultFile
    }
    # Read ONCE; hash those exact bytes before JSON parsing. No later reread of the user plan.
    $bytes=[IO.File]::ReadAllBytes($PlanFile)
    if ($PlanSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Hash-Bytes $bytes) -ne $PlanSha256) {throw 'Plan SHA-256 mismatch.'}
    $plan=$utf8.GetString($bytes) | ConvertFrom-Json
    Validate-Plan $plan
    $script:plan=$plan
    if (!$DryRun) {
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
        $principal=New-Object Security.Principal.WindowsPrincipal($identity)
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Administrator access required; use lda to request elevation.'}
    }
    foreach ($op in $plan.operations) {
        $item=@{op=$op.op; module=$op.module; ok=$false; message=''; details=@{}}
        try {
            if ($DryRun) {
                $line="DRY RUN: $($op.op) $($op.module); validate owner and write access of every runtime and code folder first"
                if ($op.op -in @('install','upgrade','adopt')) {$line+='; re-verify zip SHA-256; reject archive traversal/links; stage code in Program Files'}
                if ($op.op -eq 'install') {$line+="; port $($op.port); runtime $($op.runtimeRoot) (trusted folder chain; empty or runtime layout only; no overlap with another module; create missing folders with a fixed DACL); write runtime marker; replace DACL before credentials; preserve tenants.json; pinned WinSW v2.12.0; trusted node.exe and its folders; register; start; health expected version (30 s); commit versions.json"}
                if ($op.op -eq 'upgrade') {$line+='; preserve port/memory/env; stop; switch XML; start; health; trusted node.exe from the service XML; on failure stop, restore previous XML, start and verify health as separate reported steps, delete the failed candidate only when recovery completed (otherwise keep and report it); commit current/previous in versions.json (no pruning if that write fails); keep current and previous'}
                if ($op.op -eq 'adopt') {$line+='; legacy must run as LocalService; read legacy XML; retain runtime/port/memory/tenants; snapshot runtime and service folder permissions; normalise runtime ACLs to the standard policy; stop legacy (registration kept); register new id with the verified legacy wrapper; start; health; commit versions.json; then unregister legacy and back up then delete its wrapper files; on failure (commit included) remove the new service, restore the permissions, restart legacy only if it was running and verify /health'}
                if ($op.op -eq 'rollback') {$line+='; switch to the committed previous version from versions.json; switch XML; restart; health; restore on failure'}
                if ($op.op -eq 'uninstall') {$line+="; stop; unregister; safe-delete code; purge=$($op.purge) (runtime marker must match module and path; validate runtime layout and XML; no reparse points)"}
                Write-Output $line; $result.log+=$line
            } else {Invoke-Operation $op}
            $item.ok=$true; $item.message='Completed'
        } catch {$item.message=$_.Exception.Message; throw}
        finally {$result.operations+=,$item}
    }
    $result.ok=$true; $exitCode=0
} catch {$result.log+=$_.Exception.Message; Write-Output "ERROR: $($_.Exception.Message)"}
finally {
    if ($resultStream) {Write-Result $resultStream}
}
exit $exitCode
