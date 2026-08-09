param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
if ((Get-Process -Id $PID).SessionId -eq 0) {
  throw "windows-window-inventory must run in a logged-in desktop session"
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FlabWindowInventory {
  public sealed class Item {
    public long handle;
    public int pid;
    public bool visible;
    public bool minimized;
    public string title;
    public string className;
    public int x;
    public int y;
    public int width;
    public int height;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
  private delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);

  public static Item[] Read() {
    var items = new List<Item>();
    EnumWindows((window, state) => {
      int pid;
      GetWindowThreadProcessId(window, out pid);
      var title = new StringBuilder(1024);
      var className = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      GetClassName(window, className, className.Capacity);
      Rect rect;
      GetWindowRect(window, out rect);
      items.Add(new Item {
        handle = window.ToInt64(), pid = pid, visible = IsWindowVisible(window), minimized = IsIconic(window),
        title = title.ToString(), className = className.ToString(), x = rect.left, y = rect.top,
        width = rect.right - rect.left, height = rect.bottom - rect.top
      });
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }
}
'@

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
[FlabWindowInventory]::Read() | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
