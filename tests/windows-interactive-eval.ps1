param(
    [Parameter(Mandatory = $true)]
    [string]$Config
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ((Get-Process -Id $PID).SessionId -eq 0) {
    throw "windows-interactive-eval must run in a logged-in desktop session"
}

$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
foreach ($required in @("workdir", "target", "expression", "output")) {
    if (-not $settings.$required) {
        throw "missing config field: $required"
    }
}

Set-Location -LiteralPath $settings.workdir
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& bun src/bin.ts run $settings.target --no-watch --eval $settings.expression --json *> $settings.output
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference

if ($exitCode -ne 0) {
    throw "flab eval failed with exit code $exitCode; see $($settings.output)"
}
