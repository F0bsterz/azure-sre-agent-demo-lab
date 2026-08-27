<#
.SYNOPSIS
    Deallocates the lab's compute to reduce cost between demos.

.DESCRIPTION
    Deallocates both VMs and stops the AKS cluster. Disks, container registry,
    Log Analytics, Key Vault and networking are left intact so start-lab.ps1
    restores the same environment.

    Prints which resources continue to accrue cost while stopped.

.EXAMPLE
    .\scripts\stop-lab.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib.ps1')

Invoke-LabScript -ScriptName 'stop-lab.sh'
