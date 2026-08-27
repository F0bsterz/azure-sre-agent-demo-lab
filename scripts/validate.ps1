<#
.SYNOPSIS
    Verifies that a deployed Azure SRE Agent Demo Lab is healthy.

.DESCRIPTION
    Prints PASS or FAIL for every component: Azure resources, the Scenario
    Controller, PostgreSQL, AKS, Magic 8 Ball, TLS, networking, telemetry and
    alert rules. Exits non-zero if any check fails, so it can gate a demo or a
    pipeline.

.EXAMPLE
    .\scripts\validate.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib.ps1')

Invoke-LabScript -ScriptName 'validate.sh'
