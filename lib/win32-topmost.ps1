# Runtime helper for the "window pin" plugin.
#
# The Harness Host process starts this script once and keeps it alive; each line
# on stdin is one request, and exactly one JSON line is written back on stdout.
#
#   <action> <ownerProcessId>
#
# action: status | toggle | on | off
# ownerProcessId: the Electron main process that owns the desktop window (the
#                 Host process its own parent), or 0 to fall back to the title.
#
# Output: {"ok":true,"topmost":false,"title":"...","hwnd":123}
#      or {"ok":false,"error":"..."}

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$windowTitleSuffix = 'DeepSeek Harness'

try {
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshPinTop {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
"@
} catch {
    [Console]::Out.WriteLine('{"ok":false,"error":"helper-init-failed"}')
    exit 1
}

function Get-DesktopWindows {
    $script:scanned = New-Object System.Collections.ArrayList
    $callback = [DshPinTop+EnumProc] {
        param([IntPtr] $hWnd, [IntPtr] $lParam)
        $procId = [uint32] 0
        [void] [DshPinTop]::GetWindowThreadProcessId($hWnd, [ref] $procId)
        $class = New-Object System.Text.StringBuilder 256
        [void] [DshPinTop]::GetClassNameW($hWnd, $class, 256)
        if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
        if (-not [DshPinTop]::IsWindowVisible($hWnd)) { return $true }
        $title = New-Object System.Text.StringBuilder 512
        [void] [DshPinTop]::GetWindowTextW($hWnd, $title, 512)
        [void] $script:scanned.Add([pscustomobject] @{
                Hwnd  = $hWnd.ToInt64()
                Pid   = [int] $procId
                Title = $title.ToString()
            })
        return $true
    }
    [void] [DshPinTop]::EnumWindows($callback, [IntPtr]::Zero)
    return $script:scanned
}

function Get-TargetWindow([int] $ownerProcessId) {
    $windows = Get-DesktopWindows
    if ($null -eq $windows -or $windows.Count -eq 0) { return $null }
    $match = $null
    if ($ownerProcessId -gt 0) {
        $match = $windows | Where-Object { $_.Pid -eq $ownerProcessId } | Select-Object -First 1
    }
    if ($null -eq $match) {
        $match = $windows | Where-Object { $_.Title.EndsWith($script:windowTitleSuffix) } | Select-Object -First 1
    }
    return $match
}

function Invoke-WindowAction([string] $action, [int] $ownerProcessId) {
    $window = Get-TargetWindow $ownerProcessId
    if ($null -eq $window) { return @{ ok = $false; error = 'no-window'; topmost = $false } }
    $handle = [IntPtr] $window.Hwnd
    $extended = [DshPinTop]::GetWindowLong($handle, -20)
    $isTopmost = (($extended -band 0x8) -ne 0)
    $result = @{ ok = $true; topmost = $isTopmost; title = $window.Title; hwnd = $window.Hwnd }
    switch ($action) {
        'status' { return $result }
        'toggle' { $wantTopmost = -not $isTopmost }
        'on' { $wantTopmost = $true }
        'off' { $wantTopmost = $false }
        default { return @{ ok = $false; error = 'bad-action'; topmost = $isTopmost } }
    }
    if ($wantTopmost) { $insertAfter = [IntPtr] (-1) } else { $insertAfter = [IntPtr] (-2) }
    # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    $flags = 0x0001 -bor 0x0002 -bor 0x0010
    $applied = [DshPinTop]::SetWindowPos($handle, $insertAfter, 0, 0, 0, 0, [uint32] $flags)
    $nowTopmost = (([DshPinTop]::GetWindowLong($handle, -20) -band 0x8) -ne 0)
    $result.topmost = $nowTopmost
    if (-not $applied -and $nowTopmost -ne $wantTopmost) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        return @{ ok = $false; error = ('set-window-pos-failed-' + $code); topmost = $nowTopmost; title = $window.Title }
    }
    return $result
}

[Console]::Out.WriteLine('{"ok":true,"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line.Split(' ')
    $action = $parts[0]
    $ownerProcessId = 0
    if ($parts.Length -gt 1) { [void] [int]::TryParse($parts[1], [ref] $ownerProcessId) }
    try {
        $payload = Invoke-WindowAction $action $ownerProcessId
    } catch {
        $payload = @{ ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
