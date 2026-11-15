# Runtime helper for the "desktop sticky note" window.
#
# The Harness Host process starts this script once and keeps it alive. Each line
# on stdin is one JSON request; exactly one JSON line is written back on stdout.
#
#   {"action":"status",  "title":"便利贴"}
#   {"action":"topmost", "title":"便利贴", "on":true}
#   {"action":"activate","title":"便利贴"}
#   {"action":"close",   "title":"便利贴"}
#
# Output: {"ok":true,"found":true,"topmost":true,"hwnd":123,"title":"便利贴"}
#      or {"ok":true,"found":false}
#      or {"ok":false,"error":"..."}
#
# The note window is an Edge/Chrome app-mode window, so it is a top-level window
# of class "Chrome_WidgetWin_1". Matching is by title: exact, or a title that
# starts with the requested text (the desktop page keeps a fixed title).

$ErrorActionPreference = 'Stop'
# The protocol is UTF-8 JSON and the note title is Chinese, so stdin must be read
# as UTF-8 too: Windows PowerShell otherwise decodes the pipe with the ANSI code
# page, and a title that never matches would leave the window off the top layer.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshNoteWindow {
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
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);
}
"@
} catch {
    [Console]::Out.WriteLine('{"ok":false,"error":"helper-init-failed"}')
    exit 1
}

function Get-WorkArea {
    try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop } catch { }
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    return @{ ok = $true; work = @{ x = $area.X; y = $area.Y; width = $area.Width; height = $area.Height } }
}

function Get-NoteWindows([string] $titleWanted) {
    $script:scanned = New-Object System.Collections.ArrayList
    $callback = [DshNoteWindow+EnumProc] {
        param([IntPtr] $hWnd, [IntPtr] $lParam)
        $procId = [uint32] 0
        [void] [DshNoteWindow]::GetWindowThreadProcessId($hWnd, [ref] $procId)
        $class = New-Object System.Text.StringBuilder 256
        [void] [DshNoteWindow]::GetClassNameW($hWnd, $class, 256)
        if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
        if (-not [DshNoteWindow]::IsWindowVisible($hWnd)) { return $true }
        $title = New-Object System.Text.StringBuilder 512
        [void] [DshNoteWindow]::GetWindowTextW($hWnd, $title, 512)
        $text = $title.ToString()
        if ($titleWanted -ne '') {
            if (-not ($text -eq $titleWanted -or $text.StartsWith($titleWanted))) { return $true }
        }
        [void] $script:scanned.Add([pscustomobject] @{
                Hwnd  = $hWnd.ToInt64()
                Pid   = [int] $procId
                Title = $text
            })
        return $true
    }
    [void] [DshNoteWindow]::EnumWindows($callback, [IntPtr]::Zero)
    return $script:scanned
}

function Get-NoteWindow([string] $titleWanted) {
    $windows = Get-NoteWindows $titleWanted
    if ($null -eq $windows -or $windows.Count -eq 0) { return $null }
    return $windows | Select-Object -First 1
}

function Test-Topmost([IntPtr] $handle) {
    $extended = [DshNoteWindow]::GetWindowLong($handle, -20)
    return (($extended -band 0x8) -ne 0)
}

function Invoke-NoteAction($request) {
    $title = ''
    if ($null -ne $request.title) { $title = [string] $request.title }
    $window = Get-NoteWindow $title
    if ($null -eq $window) { return @{ ok = $true; found = $false } }

    $handle = [IntPtr] $window.Hwnd
    $result = @{
        ok      = $true
        found   = $true
        hwnd    = $window.Hwnd
        pid     = $window.Pid
        title   = $window.Title
        topmost = (Test-Topmost $handle)
    }

    switch ([string] $request.action) {
        'status' { }
        'activate' {
            [void] [DshNoteWindow]::ShowWindow($handle, 9)   # SW_RESTORE
            [void] [DshNoteWindow]::SetForegroundWindow($handle)
        }
        'topmost' {
            $want = $true
            if ($null -ne $request.on) { $want = [bool] $request.on }
            if ($want) { $insertAfter = [IntPtr] (-1) } else { $insertAfter = [IntPtr] (-2) }
            # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
            $flags = 0x0001 -bor 0x0002 -bor 0x0010
            $applied = [DshNoteWindow]::SetWindowPos($handle, $insertAfter, 0, 0, 0, 0, [uint32] $flags)
            $result.topmost = (Test-Topmost $handle)
            if ($want -and -not $result.topmost) {
                # A browser window that has only just been created can accept the
                # call and still be pushed back by the browser's own show pass.
                # Showing it once and retrying settles the layer.
                [void] [DshNoteWindow]::ShowWindow($handle, 5)   # SW_SHOW
                [void] [DshNoteWindow]::SetForegroundWindow($handle)
                Start-Sleep -Milliseconds 120
                [void] [DshNoteWindow]::SetWindowPos($handle, [IntPtr] (-1), 0, 0, 0, 0, [uint32] $flags)
                $result.topmost = (Test-Topmost $handle)
            }
            if (-not $applied -and $result.topmost -ne $want) {
                $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                return @{ ok = $false; found = $true; error = ('set-window-pos-failed-' + $code); topmost = $result.topmost }
            }
        }
        'move' {
            # SWP_NOZORDER | SWP_NOACTIVATE: place the window without touching
            # which layer it sits on.
            $flags = 0x0004 -bor 0x0010
            $applied = [DshNoteWindow]::SetWindowPos(
                $handle, [IntPtr]::Zero,
                [int] $request.x, [int] $request.y, [int] $request.w, [int] $request.h,
                [uint32] $flags)
            $result.moved = [bool] $applied
            if (-not $applied) {
                $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                return @{ ok = $false; found = $true; error = ('move-failed-' + $code) }
            }
        }
        'close' {
            [void] [DshNoteWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
            $result.closing = $true
        }
        default { return @{ ok = $false; error = 'bad-action' } }
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
    try {
        $request = $line | ConvertFrom-Json
        if ([string] $request.action -eq 'screen') {
            $payload = Get-WorkArea
        } else {
            $payload = Invoke-NoteAction $request
        }
    } catch {
        $payload = @{ ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
