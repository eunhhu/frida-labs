param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][string]$ScreenshotPath,
  [switch]$SkipActivate
)

$ErrorActionPreference = 'Stop'
if ((Get-Process -Id $PID).SessionId -eq 0) {
  throw 'windows-ui-driver must run in the logged-in interactive desktop session'
}
$targets = @(Get-Process -Name $ProcessName -ErrorAction Stop)
if ($targets.Count -ne 1) {
  throw "expected exactly one $ProcessName process; found $($targets.Count)"
}
$parsedSteps = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$steps = New-Object System.Collections.ArrayList
if ($parsedSteps -is [Array]) {
  foreach ($parsedStep in $parsedSteps) { [void]$steps.Add($parsedStep) }
} else {
  [void]$steps.Add($parsedSteps)
}
if ($steps.Count -gt 100) { throw 'UI plan exceeds 100 steps' }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FlabUiInput {
  private delegate bool WindowCallback(IntPtr window, IntPtr state);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);

  public static bool ActivateProcessWindow(int processId) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((window, state) => {
      int pid;
      GetWindowThreadProcessId(window, out pid);
      Rect rect;
      if (pid == processId && IsWindowVisible(window) && GetWindowRect(window, out rect)) {
        long area = Math.Max(0, rect.right - rect.left) * (long)Math.Max(0, rect.bottom - rect.top);
        if (area > bestArea) { best = window; bestArea = area; }
      }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return false;
    ShowWindow(best, 9);
    BringWindowToTop(best);
    return SetForegroundWindow(best);
  }
}
'@

$shell = New-Object -ComObject WScript.Shell
if (-not $SkipActivate -and -not [FlabUiInput]::ActivateProcessWindow($targets[0].Id) -and -not $shell.AppActivate($targets[0].Id)) {
  throw "could not activate $ProcessName; use -SkipActivate only for screenshot-only plans"
}
Start-Sleep -Milliseconds 300
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

foreach ($step in $steps) {
  $waitMs = if ($null -eq $step.waitMs) { 200 } else { [int]$step.waitMs }
  if ($waitMs -lt 0 -or $waitMs -gt 30000) { throw 'waitMs must be within 0..30000' }
  switch ($step.type) {
    'key' {
      if ([string]::IsNullOrWhiteSpace([string]$step.value)) { throw 'key step requires value' }
      $shell.SendKeys([string]$step.value)
    }
    'hold' {
      if ([string]::IsNullOrWhiteSpace([string]$step.value)) { throw 'hold step requires value' }
      $durationMs = [int]$step.durationMs
      if ($durationMs -lt 1 -or $durationMs -gt 10000) { throw 'hold durationMs must be within 1..10000' }
      try { $key = [System.Windows.Forms.Keys]([System.Enum]::Parse([System.Windows.Forms.Keys], [string]$step.value, $true)) }
      catch { throw "unknown hold key $($step.value)" }
      $virtualKey = [byte]$key
      $scanCode = [byte][FlabUiInput]::MapVirtualKey($virtualKey, 0)
      $extended = if ($key -in @([System.Windows.Forms.Keys]::Left, [System.Windows.Forms.Keys]::Right, [System.Windows.Forms.Keys]::Up, [System.Windows.Forms.Keys]::Down)) { 1 } else { 0 }
      [FlabUiInput]::keybd_event($virtualKey, $scanCode, $extended, [UIntPtr]::Zero)
      try { Start-Sleep -Milliseconds $durationMs }
      finally { [FlabUiInput]::keybd_event($virtualKey, $scanCode, (2 -bor $extended), [UIntPtr]::Zero) }
    }
    'click' {
      $x = [int]$step.x
      $y = [int]$step.y
      if ($x -lt $bounds.Left -or $x -ge $bounds.Right -or $y -lt $bounds.Top -or $y -ge $bounds.Bottom) {
        throw "click outside primary screen: $x,$y"
      }
      [FlabUiInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 100
      [FlabUiInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [FlabUiInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    'wait' { }
    default { throw "unsupported UI step type $($step.type)" }
  }
  if ($waitMs -gt 0) { Start-Sleep -Milliseconds $waitMs }
}

$directory = Split-Path -Parent $ScreenshotPath
if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
