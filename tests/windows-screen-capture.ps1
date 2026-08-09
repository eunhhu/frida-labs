param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
if ((Get-Process -Id $PID).SessionId -eq 0) {
  throw "windows-screen-capture must run in a logged-in desktop session"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$metadata = New-Object System.Collections.ArrayList
$index = 0
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $bounds = $screen.Bounds
  $path = Join-Path $OutputDirectory "screen-$index.png"
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  [void]$metadata.Add([pscustomobject]@{
    index = $index
    deviceName = $screen.DeviceName
    primary = $screen.Primary
    x = $bounds.X
    y = $bounds.Y
    width = $bounds.Width
    height = $bounds.Height
    path = $path
  })
  $index++
}
$metadata | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $OutputDirectory "screens.json") -Encoding UTF8
