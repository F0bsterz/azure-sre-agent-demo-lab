<#
.SYNOPSIS
    Restarts a stopped lab and verifies that its services recover.

.DESCRIPTION
    Starts PostgreSQL first, then AKS, then the App VM, then waits for the
    Scenario Controller and Magic 8 Ball to respond. Starting the database
    first avoids a burst of dependency failures that would otherwise appear in
    telemetry as a real incident.

.EXAMPLE
    .\scripts\start-lab.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib.ps1')

Invoke-LabScript -ScriptName 'start-lab.sh'
