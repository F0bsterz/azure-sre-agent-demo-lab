<#
.SYNOPSIS
    Returns the lab to baseline, clearing any active fault scenario.

.DESCRIPTION
    Stops the disk log generator and deletes only the files it created, removes
    the resource-pressure workload, restores the AKS node pool baseline and the
    stable Magic 8 Ball image, closes scenario database sessions, removes the
    scenario NSG deny rule and reinstalls the valid TLS certificate.

    Nothing is deleted and no infrastructure is removed — for that, use
    destroy-lab.ps1. Safe to run repeatedly.

.EXAMPLE
    .\scripts\reset-lab.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib.ps1')

Invoke-LabScript -ScriptName 'reset-lab.sh'
