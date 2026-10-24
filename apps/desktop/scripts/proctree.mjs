// Snapshot of a Windows process tree: working set and private bytes per process.
import { execFileSync } from 'node:child_process';

export function processTable() {
  const ps = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
  return JSON.parse(out);
}

/** Root process plus all descendants, with MB figures. */
export function tree(rootPid, table = processTable()) {
  const out = [];
  const walk = (pid) => {
    for (const p of table) {
      if (p.ProcessId === pid || (p.ParentProcessId === pid && !out.some((o) => o.pid === p.ProcessId))) {
        if (out.some((o) => o.pid === p.ProcessId)) continue;
        const type = /--type=([\w-]+)/.exec(p.CommandLine ?? '')?.[1] ?? (p.ProcessId === rootPid ? 'main' : '');
        const service = /--utility-sub-type=([\w.]+)/.exec(p.CommandLine ?? '')?.[1] ?? '';
        out.push({ pid: p.ProcessId, name: p.Name, type: service ? `${type}:${service}` : type, wsMB: +(p.WorkingSetSize / 1048576).toFixed(1), privateMB: +(p.PrivatePageCount / 1048576).toFixed(1) });
        if (p.ProcessId !== pid) walk(p.ProcessId);
      }
    }
  };
  walk(rootPid);
  return out;
}

/** CPU seconds per pid (kernel+user), for averaging CPU over an interval. */
export function cpuSeconds(pids) {
  const ps = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,TotalProcessorTime | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return Object.fromEntries(out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [id, s] = l.split(' '); return [Number(id), Number(s.replace(',', '.'))]; }));
}

/** Sends WM_CLOSE to the process's main window, exactly like the title bar close button. */
export function closeMainWindow(pid) {
  const ps = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; $h = (Get-Process -Id ${Number(pid)}).MainWindowHandle; if ($h -eq 0) { exit 2 }; [U.W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
}

const user32 = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s); public struct RECT { public int L, T, R, B; }';`;
const hwnd = (pid) => `$h = (Get-Process -Id ${Number(pid)}).MainWindowHandle; if ($h -eq 0) { exit 2 };`;
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true });

/** Restores and moves the main window (physical pixels), or maximizes it. */
export function placeWindow(pid, { x = 40, y = 40, width = 1280, height = 820, maximized = false }) {
  ps(`${user32} ${hwnd(pid)} if (${maximized ? 1 : 0}) { [U.W]::ShowWindow($h, 3) | Out-Null } else { [U.W]::ShowWindow($h, 9) | Out-Null; [U.W]::MoveWindow($h, ${x}, ${y}, ${width}, ${height}, $true) | Out-Null }`);
}

/** Brings the window above others and captures it from the screen, title bar and caption buttons included. */
export function captureWindow(pid, file) {
  ps(`${user32} Add-Type -AssemblyName System.Drawing; ${hwnd(pid)} [U.W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x43) | Out-Null; [U.W]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x43) | Out-Null; Start-Sleep -Milliseconds 400; $r = New-Object U.W+RECT; [U.W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null; $b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save('${file.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`);
}

/** Keeps the window above others (true) or releases it, so occlusion does not skew measurements. */
export function pinWindow(pid, on) {
  ps(`${user32} ${hwnd(pid)} [U.W]::ShowWindow($h, 9) | Out-Null; [U.W]::SetWindowPos($h, [IntPtr](${on ? -1 : -2}), 0, 0, 0, 0, 0x43) | Out-Null`);
}

/** Presses a hardware media key (0xB0 next, 0xB1 previous, 0xB3 play/pause) system-wide. */
export function mediaKey(vk) {
  ps(`Add-Type -Name K -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);'; [U.K]::keybd_event(${Number(vk)}, 0, 1, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [U.K]::keybd_event(${Number(vk)}, 0, 3, [UIntPtr]::Zero)`);
}
