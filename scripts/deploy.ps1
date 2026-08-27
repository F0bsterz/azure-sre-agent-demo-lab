<#
.SYNOPSIS
    Deploys the Azure SRE Agent Demo Lab.

.DESCRIPTION
    Validates prerequisites, deploys the Bicep infrastructure, builds and
    pushes the container images, configures the App VM and PostgreSQL, deploys
    the AKS workloads, installs the demo TLS certificates and runs smoke tests.

    Takes roughly 20-30 minutes on a first run.

.PARAMETER SubscriptionId
    Azure subscription to deploy into. Defaults to the current az account.

.PARAMETER Location
    Azure region, for example eastus, westus3 or uksouth.

.PARAMETER Suffix
    Reuse a specific lab suffix instead of generating a new one. Use this to
    re-run against an existing deployment.

.PARAMETER AdminCidr
    CIDR permitted to reach SSH, the Scenario Controller and Magic 8 Ball.
    Defaults to the detected public IP of this machine as a /32.

.PARAMETER SkipBuild
    Skip rebuilding container images.

.PARAMETER SkipApps
    Deploy infrastructure only.

.PARAMETER Yes
    Do not prompt for confirmation.

.EXAMPLE
    .\scripts\deploy.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000 -Location eastus

.EXAMPLE
    .\scripts\deploy.ps1 -Location westus3 -AdminCidr 203.0.113.10/32 -Yes
#>
[CmdletBinding()]
param(
    [string] $SubscriptionId,
    [string] $Location = 'eastus',
    [string] $Suffix,
    [string] $AdminCidr,
    [switch] $SkipBuild,
    [switch] $SkipApps,
    [switch] $Yes
)

. (Join-Path $PSScriptRoot 'lib.ps1')

$arguments = [System.Collections.Generic.List[string]]::new()
Add-LabOption -Arguments $arguments -Flag '--subscription' -Value $SubscriptionId
Add-LabOption -Arguments $arguments -Flag '--location'     -Value $Location
Add-LabOption -Arguments $arguments -Flag '--suffix'       -Value $Suffix
Add-LabOption -Arguments $arguments -Flag '--admin-cidr'   -Value $AdminCidr
Add-LabSwitch -Arguments $arguments -Condition $SkipBuild.IsPresent -Flag '--skip-build'
Add-LabSwitch -Arguments $arguments -Condition $SkipApps.IsPresent  -Flag '--skip-apps'
Add-LabSwitch -Arguments $arguments -Condition $Yes.IsPresent       -Flag '--yes'

Invoke-LabScript -ScriptName 'deploy.sh' -ScriptArguments $arguments.ToArray()
