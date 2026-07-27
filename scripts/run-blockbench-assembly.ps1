param(
  [switch]$Reset,
  [switch]$OpenFirst
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '1/3 Validating the shared 30-item manifest...'
& npm.cmd run assemble:cosmetics

Write-Host '2/3 Generating/resuming the Blockbench queue...'
$args = @('run', 'assemble:blockbench:all')
if ($Reset) {
  # Reset is intentionally a separate first batch so the checkpoint is never
  # erased after generation has started.
  & npm.cmd run assemble:blockbench -- --reset
}
& npm.cmd @args

Write-Host '3/4 Exporting import-ready GLB files...'
& npm.cmd run export:blockbench

Write-Host '4/4 Checking outputs...'
$validation = Get-Content -Raw (Join-Path $root 'tools\blockbench\output\validation.json') | ConvertFrom-Json
if ($validation.completed -ne $validation.total -or $validation.failed -ne 0) {
  throw "Blockbench queue is incomplete: $($validation.completed)/$($validation.total), failed $($validation.failed)."
}
Write-Host "Complete: $($validation.completed) native Blockbench models with textures."
$glbCount = (Get-ChildItem (Join-Path $root 'tools\blockbench\output\glb') -Filter *.glb).Count
if ($glbCount -ne $validation.total) { throw "Expected $($validation.total) GLB files, found $glbCount." }
Write-Host "Import-ready GLBs: $glbCount"

if ($OpenFirst) {
  $exe = Join-Path $root 'tools\blockbench\Blockbench_5.1.5_portable.exe'
  $model = Join-Path $root 'tools\blockbench\output\bbmodel\dangle_dice.bbmodel'
  if (Test-Path $exe) { Start-Process -FilePath $exe -ArgumentList $model -WorkingDirectory (Split-Path $exe) }
}
