import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// Everything that differs between macOS, Windows and Linux lives here, so the rest of the code stays the same on all
// three. macOS is the tested platform; the Windows and Linux branches are written to each system's own documented
// tools but have not been run on a real machine yet.
export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

// How the panel names this computer and its bin, so nothing says "Mac" on a PC.
export const COMPUTER = IS_MAC ? "this Mac" : IS_WIN ? "this PC" : "this computer";
export const BIN = IS_MAC ? "the Mac's Trash" : IS_WIN ? "the Recycle Bin" : "the Trash";

export const FFMPEG_HINT = IS_MAC ? "brew install ffmpeg" : IS_WIN ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

// PowerShell single-quoted string: the only character that needs escaping is the quote itself.
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

// Puts a file or folder in the system's own bin so it can be restored: the Mac's Trash, Windows' Recycle Bin, or the
// freedesktop Trash on Linux. Never deletes anything outright.
export function moveToBin(target: string): string {
  if (IS_MAC) {
    const bin = join(homedir(), ".Trash");
    const name = basename(target);
    const ext = extname(name);
    const dest = existsSync(join(bin, name)) ? join(bin, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`) : join(bin, name);
    renameSync(target, dest);
    return dest;
  }
  if (IS_WIN) {
    const kind = statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    );
    return BIN;
  }
  try {
    execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return BIN;
  } catch {
    const bin = join(homedir(), ".local", "share", "Trash", "files");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${Date.now()}`);
    renameSync(target, dest);
    return dest;
  }
}

// Unpacks a ZIP with the system's own tools: tar on macOS and Windows 10+ is bsdtar, which reads ZIPs; unzip is the
// fallback (Linux, older Windows). Returns every file inside, however deeply the archive nested them.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  return files;
}

// Flow is driven through a real window, and an idle Mac turns its display off and then locks, after which Chrome paints
// nothing and no click lands (a laptop on battery dims after 2 minutes). While jobs run, `caffeinate -d` keeps the display
// on; -w ties it to this process so it can never outlive the tool. Elsewhere this does nothing. Returns the release.
export function keepDisplayAwake(): () => void {
  if (!IS_MAC) return () => {};
  try {
    const child = spawn("caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => {});
    return () => void child.kill();
  } catch {
    return () => {};
  }
}

// Seconds since the user last touched the keyboard or mouse (macOS: the HID system's idle time), or undefined elsewhere.
export function idleSeconds(): number | undefined {
  if (!IS_MAC) return undefined;
  try {
    const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const ns = out.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
    return ns ? Number(ns) / 1e9 : undefined;
  } catch {
    return undefined;
  }
}

// Whether the Mac's screen is locked (the login window is up), when it can be told.
export function screenLocked(): boolean {
  if (!IS_MAC) return false;
  try {
    return /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8", timeout: 5000 }));
  } catch {
    return false;
  }
}

// Brings an app to the front (macOS `open -a`, which needs no permission, unlike AppleScript).
export function activateApp(name: string): void {
  try {
    if (IS_MAC) execFileSync("open", ["-a", name], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // the caller checks whether it worked
  }
}

// The command line of the process listening on a local TCP port, or undefined when it cannot be told (no lsof, no
// PowerShell networking cmdlets, nothing listening).
export function listenerCommandLine(port: number): string | undefined {
  try {
    if (IS_WIN) {
      const out = powershell(
        `$p = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess; (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine`,
        15_000,
      );
      return out.trim() || undefined;
    }
    const pid = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 10_000 }).trim().split(/\s+/)[0];
    if (!pid) return undefined;
    return execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8", timeout: 10_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// Opens a page in the default browser.
export function openUrl(url: string): void {
  try {
    if (IS_MAC) execFileSync("open", [url], { stdio: "ignore" });
    else if (IS_WIN) execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // Opening the browser is a convenience; the address is printed either way.
  }
}
