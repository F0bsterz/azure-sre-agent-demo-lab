<#
.SYNOPSIS
    Shared helpers for the Azure SRE Agent Demo Lab PowerShell entry points.

.DESCRIPTION
    The lab's deployment logic lives in the Bash scripts alongside these files.
    These PowerShell wrappers provide a native command surface (parameter
    validation, tab completion, -WhatIf where relevant) and then delegate.

    That is a deliberate decision. Maintaining two independent implementations
    of a twenty-step deployment guarantees they drift, and a demo lab that
    behaves differently on Windows than on Linux is worse than one that has a
    single, well-tested path. Git for Windows — already required in order to
    clone this repository — ships the Bash used here, so there is no additional
    prerequisite in practice.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LabRepoRoot {
    Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

function Find-Bash {
    <#
        Resolution order:
          1. bash already on PATH (Linux, macOS, WSL default, Git Bash on PATH)
          2. Git for Windows' bundled bash in its usual install locations
          3. WSL, as a last resort
    #>
    $candidate = Get-Command bash -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }

    $gitBashPaths = @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )
    foreach ($path in $gitBashPaths) {
        if ($path -and (Test-Path -LiteralPath $path)) { return $path }
    }

    $wsl = Get-Command wsl -ErrorAction SilentlyContinue
    if ($wsl) { return 'wsl-bash' }

    throw @'
Bash is required but was not found.

Install Git for Windows (which includes Bash) from https://git-scm.com/download/win
or enable WSL with: wsl --install

On Linux and macOS, install bash through your package manager.
'@
}

function ConvertTo-BashPath {
    param([Parameter(Mandatory)][string] $Path)

    # Git Bash understands Windows paths, but WSL needs /mnt/<drive>/... form.
    if ($Path -match '^([A-Za-z]):[\\/](.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2] -replace '\\', '/'
        return "/mnt/$drive/$rest"
    }
    return ($Path -replace '\\', '/')
}

function Invoke-LabScript {
    <#
    .SYNOPSIS
        Runs one of the lab's Bash scripts and surfaces its exit code.
    #>
    param(
        [Parameter(Mandatory)][string]   $ScriptName,
        [Parameter()][string[]]          $ScriptArguments = @()
    )

    $repoRoot = Get-LabRepoRoot
    $scriptPath = Join-Path (Join-Path $repoRoot 'scripts') $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Script not found: $scriptPath"
    }

    $bash = Find-Bash

    if ($bash -eq 'wsl-bash') {
        $wslScript = ConvertTo-BashPath $scriptPath
        Write-Verbose "Running via WSL: $wslScript $($ScriptArguments -join ' ')"
        & wsl bash $wslScript @ScriptArguments
    }
    else {
        Write-Verbose "Running via $bash : $scriptPath $($ScriptArguments -join ' ')"
        & $bash $scriptPath @ScriptArguments
    }

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$ScriptName exited with code $exitCode."
    }
}

function Add-LabSwitch {
    <#
        Appends a flag only when the switch was actually supplied, so unset
        switches do not become explicit "false" arguments.
    #>
    param(
        [Parameter(Mandatory)][System.Collections.Generic.List[string]] $Arguments,
        [Parameter(Mandatory)][bool]   $Condition,
        [Parameter(Mandatory)][string] $Flag
    )
    if ($Condition) { $Arguments.Add($Flag) }
}

function Add-LabOption {
    param(
        [Parameter(Mandatory)][System.Collections.Generic.List[string]] $Arguments,
        [Parameter(Mandatory)][string] $Flag,
        [Parameter()][string]          $Value
    )
    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $Arguments.Add($Flag)
        $Arguments.Add($Value)
    }
}
