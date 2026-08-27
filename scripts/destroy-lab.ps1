<#
.SYNOPSIS
    Deletes the lab's resource group and everything in it.

.DESCRIPTION
    Deletes only the resource group recorded in .lab-state.json, or one named
    explicitly. The target must carry the tag project=azure-sre-agent-demo, so
    a group this lab did not create cannot be deleted by accident. Subscription
    scope deletion is never used.

    Use -DryRun to review exactly what would be removed without deleting
    anything.

.PARAMETER ResourceGroup
    Resource group to delete. Defaults to the one in .lab-state.json.

.PARAMETER DryRun
    List what would be deleted, then exit without deleting.

.PARAMETER Yes
    Skip the typed confirmation prompt.

.EXAMPLE
    .\scripts\destroy-lab.ps1 -DryRun

.EXAMPLE
    .\scripts\destroy-lab.ps1 -ResourceGroup rg-sre-demo-a1b2c3 -Yes
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string] $ResourceGroup,
    [switch] $DryRun,
    [switch] $Yes
)

. (Join-Path $PSScriptRoot 'lib.ps1')

$arguments = [System.Collections.Generic.List[string]]::new()
Add-LabOption -Arguments $arguments -Flag '--resource-group' -Value $ResourceGroup
Add-LabSwitch -Arguments $arguments -Condition $DryRun.IsPresent -Flag '--dry-run'
Add-LabSwitch -Arguments $arguments -Condition $Yes.IsPresent    -Flag '--yes'

$target = if ($ResourceGroup) { $ResourceGroup } else { 'the resource group in .lab-state.json' }

if ($DryRun -or $PSCmdlet.ShouldProcess($target, 'Delete resource group and all contained resources')) {
    Invoke-LabScript -ScriptName 'destroy-lab.sh' -ScriptArguments $arguments.ToArray()
}
