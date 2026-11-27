import { spawn } from "node:child_process";
import { lstat, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export interface TrashResult {
  /**
   * Paths that could not be moved, with a reason. Missing files are not failures. `too-large`: the
   * file is bigger than its drive's Recycle Bin and stays until it is sent again with `permanent`.
   */
  failed: Array<{ path: string; message: string; code?: "too-large" }>;
}

export interface TrashOptions {
  /** Delete files too large for the Recycle Bin for good. No other refusal is bypassed. */
  permanent?: boolean;
}

export type TrashFn = (paths: string[], options?: TrashOptions) => Promise<TrashResult>;

/** Runs one program with data on stdin; resolves with its exit code and stdout. */
export type TrashRunner = (
  command: string,
  args: string[],
  stdin: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- Windows ---------------------------------------------------------------------------------

/**
 * Reads base64 UTF-8 JSON `{ paths, permanent }` from stdin and recycles each path with
 * SHFileOperation, with no dialogs. Only fixed drives have a Recycle Bin that FOF_ALLOWUNDO honors;
 * anywhere else the call would delete for good, so those paths are refused. A file larger than the
 * bin is refused with code `too-large`, or, only with `permanent`, deleted for good. Writes base64
 * UTF-8 JSON failures to stdout.
 */
export const WINDOWS_TRASH_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MediaForgeTrash {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool GetVolumeNameForVolumeMountPointW(string mountPoint, System.Text.StringBuilder name, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern uint GetDriveTypeW(string root);
  /** DRIVE_FIXED is 3. */
  public static uint DriveType(string root) { return GetDriveTypeW(root); }
  /** The {GUID} of the volume mounted at root (e.g. C:\), or null. */
  public static string VolumeGuid(string root) {
    var sb = new System.Text.StringBuilder(64);
    if (!GetVolumeNameForVolumeMountPointW(root, sb, 64)) return null;
    string s = sb.ToString();
    int a = s.IndexOf('{'), b = s.IndexOf('}');
    return a >= 0 && b > a ? s.Substring(a, b - a + 1) : null;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool GetVolumePathNameW(string path, System.Text.StringBuilder root, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool GetDiskFreeSpaceExW(string dir, out ulong available, out ulong total, out ulong free);
  /** The mount root of the volume that holds path (a drive root or a mounted folder), or null. */
  public static string VolumeRoot(string path) {
    var sb = new System.Text.StringBuilder(1024);
    if (!GetVolumePathNameW(path, sb, 1024)) return null;
    string s = sb.ToString();
    return s.Length == 0 ? null : (s.EndsWith("\\") ? s : s + "\\");
  }
  /** Total size of the volume mounted at root, or -1. */
  public static long TotalBytes(string root) {
    ulong available, total, free;
    return GetDiskFreeSpaceExW(root, out available, out total, out free) ? (long)total : -1;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(IntPtr file, System.Text.StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  /** The real path of an existing file, through junctions and symlinks; UNC stays UNC. Null if unknown. */
  public static string FinalPath(string path) {
    // No access rights; FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE; OPEN_EXISTING;
    // FILE_FLAG_BACKUP_SEMANTICS so folders open too.
    IntPtr h = CreateFileW(path, 0, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return null;
    try {
      var sb = new System.Text.StringBuilder(32768);
      // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS (both 0).
      uint n = GetFinalPathNameByHandleW(h, sb, 32767, 0x0 | 0x0);
      if (n == 0 || n >= 32767) return null;
      string s = sb.ToString();
      if (s.StartsWith(@"\\?\UNC\")) return @"\\" + s.Substring(8);
      if (s.StartsWith(@"\\?\")) return s.Substring(4);
      return s;
    } finally { CloseHandle(h); }
  }
  public static int Recycle(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = path + "\0\0";
    // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0400 | 0x0004);
    int code = SHFileOperation(ref op);
    return code != 0 ? code : (op.fAnyOperationsAborted ? -1 : 0);
  }
}
'@
$bitBucketVolumes = 'Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume'
$explorerPolicies = 'Software\Microsoft\Windows\CurrentVersion\Policies\Explorer'
function Read-RegistryValues($hive, $subKey, $names) {
  # $null when the key does not exist; throws when it cannot be opened or read (fail closed).
  $base = if ($hive -eq 'HKCU') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }
  $key = $base.OpenSubKey($subKey)
  if ($null -eq $key) { return $null }
  try {
    $values = @{}
    foreach ($name in $names) { $values[$name] = $key.GetValue($name) }
    return $values
  } finally { $key.Close() }
}
function Resolve-RealPath($p) {
  # Where the file really is. GetVolumePathNameW follows mount points but not junctions or folder
  # symlinks, so C:\dl\link\a.mp4 may live on a USB stick or a share. Throws (refuses) on doubt.
  $real = [MediaForgeTrash]::FinalPath($p)
  if (-not $real) { throw 'Could not find where this file really is, so it was left in place.' }
  if ($real.StartsWith('\\')) { throw 'This drive has no Recycle Bin, so the file was left in place.' }
  if ($real -notmatch '^[A-Za-z]:\\' -or -not ([System.IO.Path]::GetFullPath($real) -ceq $real)) {
    throw 'This drive has no Recycle Bin, so the file was left in place.'
  }
  return $real
}
function Get-RecycleRefusal($real) {
  # SHFileOperation deletes for good, without asking, when the bin is off or the file is too big.
  # Every doubt refuses: the file stays where it is.
  $noBin = 'This drive has no Recycle Bin, so the file was left in place.'
  $off = 'Recycle Bin is turned off for this drive, so the file was left in place.'
  try {
    $root = [MediaForgeTrash]::VolumeRoot($real)
    if (-not $root) { return $noBin }
    if ([MediaForgeTrash]::DriveType($root) -ne 3) { return $noBin }
    $guid = [MediaForgeTrash]::VolumeGuid($root)
    if (-not $guid) { return $noBin }
    $total = [MediaForgeTrash]::TotalBytes($root)
    if ($total -le 0) { return $noBin }
    $percent = 0
    foreach ($hive in 'HKCU', 'HKLM') {
      $policy = Read-RegistryValues $hive $explorerPolicies @('NoRecycleFiles', 'RecycleBinSize')
      if ($null -eq $policy) { continue }
      if ($policy.NoRecycleFiles -eq 1) { return $off }
      if ($null -ne $policy.RecycleBinSize -and [int64]$policy.RecycleBinSize -gt 0) {
        $percent = [int64]$policy.RecycleBinSize
      }
    }
    $nuke = 0
    $maxMb = 0
    $bin = Read-RegistryValues 'HKCU' ($bitBucketVolumes + '\' + $guid) @('NukeOnDelete', 'MaxCapacity')
    if ($null -ne $bin) {
      if ($null -ne $bin.NukeOnDelete) { $nuke = [int64]$bin.NukeOnDelete }
      if ($null -ne $bin.MaxCapacity) { $maxMb = [int64]$bin.MaxCapacity }
    }
    if ($nuke -eq 1) { return $off }
    if ($percent -gt 0) { $cap = [int64]($total * $percent / 100) }
    elseif ($maxMb -gt 0) { $cap = $maxMb * 1MB }
    else { $cap = [int64]($total * 0.05) }
    # Last: every other refusal stands even when the caller agreed to delete for good.
    if ((Get-Item -LiteralPath $real -Force).Length -gt $cap) { return 'too-large' }
    return $null
  } catch {
    return 'Could not check this drive''s Recycle Bin settings, so the file was left in place.'
  }
}
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$request = ConvertFrom-Json $text
$permanent = ($request.permanent -is [bool]) -and $request.permanent
$failed = New-Object System.Collections.ArrayList
foreach ($p in @($request.paths | ForEach-Object { $_ })) {
  try {
    if ($null -eq $p -or $p -eq '') { continue }
    if ($p.StartsWith('\\')) { throw 'This drive has no Recycle Bin, so the file was left in place.' }
    if ($p -notmatch '^[A-Za-z]:\\' -or -not ([System.IO.Path]::GetFullPath($p) -ceq $p)) {
      throw 'The path is not a full Windows path, so the file was left in place.'
    }
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if (Test-Path -LiteralPath $p -PathType Container) { throw 'This is a folder, not a file.' }
    $real = Resolve-RealPath $p
    $refusal = Get-RecycleRefusal $real
    if ($refusal -eq 'too-large') {
      if (-not $permanent) {
        [void]$failed.Add(@{ path = $p; message = 'The file is larger than this drive''s Recycle Bin; it would be deleted permanently.'; code = 'too-large' })
        continue
      }
      # The user confirmed: delete the resolved file for good, then make sure it is gone.
      [System.IO.File]::Delete($real)
      if (Test-Path -LiteralPath $real) { throw 'The file could not be deleted.' }
      continue
    }
    if ($refusal) { throw $refusal }
    # Recycle the resolved path, so the file that passed the checks is the file that moves.
    $code = [MediaForgeTrash]::Recycle($real)
    if ($code -ne 0) { throw ('Windows could not move it to the Recycle Bin (code ' + $code + ').') }
    if (Test-Path -LiteralPath $p) { throw 'The file is in use.' }
  } catch {
    [void]$failed.Add(@{ path = $p; message = $_.Exception.Message })
  }
}
$json = ConvertTo-Json -InputObject @($failed) -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

/** `powershell.exe` with the fixed script; no path or user text is part of the command line. */
export function windowsTrashCommand(): { command: string; args: string[] } {
  return {
    // Full path: a bare name is searched in the current folder first on Windows.
    command: join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WINDOWS_TRASH_SCRIPT, "utf16le").toString("base64"),
    ],
  };
}

const spawnRunner: TrashRunner = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolve({ exitCode: -1, stdout, stderr: message(error) }));
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** One PowerShell call per batch. */
export function windowsTrash(run: TrashRunner = spawnRunner): TrashFn {
  return async (paths, options = {}) => {
    if (paths.length === 0) return { failed: [] };
    const { command, args } = windowsTrashCommand();
    const request = { paths, permanent: options.permanent === true };
    const stdin = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    const everyPath = (reason: string): TrashResult => ({
      failed: paths.map((path) => ({ path, message: reason })),
    });
    const { exitCode, stdout } = await run(command, args, stdin);
    if (exitCode !== 0) return everyPath("Could not reach the Windows Recycle Bin.");
    try {
      const parsed: unknown = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a list");
      return {
        failed: parsed.map((item) => ({
          path: String((item as { path?: unknown }).path),
          message: String((item as { message?: unknown }).message),
          ...((item as { code?: unknown }).code === "too-large" && { code: "too-large" as const }),
        })),
      };
    } catch {
      return everyPath("Could not read the Windows Recycle Bin's answer.");
    }
  };
}

// --- Linux (freedesktop.org Trash specification 1.0) -----------------------------------------

export interface LinuxTrashDeps {
  env: Record<string, string | undefined>;
  home: string;
  uid: number;
  now: () => Date;
  /** Device id of an existing path; the default reads `stat().dev`. Tests fake other mounts. */
  deviceOf?: (path: string) => Promise<number>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, `YYYY-MM-DDThh:mm:ss`, as the spec asks. */
const deletionDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;

/** Percent-encode each path segment, keeping the separators. */
const encodePath = (path: string) => path.split(sep).map(encodeURIComponent).join("/");

const isMissing = (error: unknown) => (error as { code?: string }).code === "ENOENT";

/** There is no size limit on the freedesktop.org trash, so `permanent` has nothing to do here. */
export function linuxTrash(deps: LinuxTrashDeps): TrashFn {
  const deviceOf = deps.deviceOf ?? (async (path: string) => (await stat(path)).dev);
  const homeTrash = join(deps.env.XDG_DATA_HOME || join(deps.home, ".local", "share"), "Trash");

  /** The closest existing folder at or above `path`. */
  const existingAncestor = async (path: string): Promise<string> => {
    let current = path;
    for (;;) {
      try {
        await stat(current);
        return current;
      } catch {
        const parent = dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  };

  /** The top folder of the mount holding `path`: climb while the device stays the same. */
  const mountTop = async (path: string, device: number): Promise<string> => {
    let current = dirname(path);
    for (;;) {
      const parent = dirname(current);
      if (parent === current || (await deviceOf(parent)) !== device) return current;
      current = parent;
    }
  };

  /** Which trash folder takes `file`, and the path to record in its trashinfo. */
  const trashFor = async (file: string): Promise<{ dir: string; recorded: string }> => {
    // The link's own folder decides, not a symlink's target (which may be dangling or elsewhere).
    const device = await deviceOf(dirname(file));
    if ((await deviceOf(await existingAncestor(homeTrash))) === device) {
      return { dir: homeTrash, recorded: file };
    }
    const top = await mountTop(file, device);
    const shared = join(top, ".Trash");
    try {
      const info = await lstat(shared);
      // Usable only as a real, sticky folder; never through a symlink.
      if (info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o1000) !== 0) {
        return { dir: join(shared, String(deps.uid)), recorded: relative(top, file) };
      }
    } catch {
      // No shared trash on this mount: use the per-user one below.
    }
    return { dir: join(top, `.Trash-${deps.uid}`), recorded: relative(top, file) };
  };

  const moveOne = async (file: string): Promise<void> => {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(file);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isDirectory()) throw new Error("This is a folder, not a file.");
    const { dir, recorded } = await trashFor(file);
    const filesDir = join(dir, "files");
    const infoDir = join(dir, "info");
    if (dir !== homeTrash) {
      // A per-mount trash folder sits in a shared place: make sure it is ours before using it.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const own = await lstat(dir);
      const ownerOk = process.platform === "win32" || own.uid === deps.uid;
      if (!own.isDirectory() || own.isSymbolicLink() || !ownerOk) {
        throw new Error("The trash folder on this drive is not safe to use.");
      }
    }
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    await mkdir(infoDir, { recursive: true, mode: 0o700 });
    const name = basename(file);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const body = `[Trash Info]\nPath=${encodePath(recorded)}\nDeletionDate=${deletionDate(deps.now())}\n`;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
      const infoPath = join(infoDir, `${candidate}.trashinfo`);
      try {
        // Creating the info file exclusively reserves the name, as the spec asks.
        await writeFile(infoPath, body, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") continue;
        throw error;
      }
      // An orphan in files/ (no info) would be overwritten by rename: take the next name instead.
      const taken = await lstat(join(filesDir, candidate)).then(
        () => true,
        () => false,
      );
      if (taken) {
        await unlink(infoPath).catch(() => {});
        continue;
      }
      try {
        await rename(file, join(filesDir, candidate));
      } catch (error) {
        await unlink(infoPath).catch(() => {});
        throw error;
      }
      return;
    }
  };

  return async (paths) => {
    const failed: TrashResult["failed"] = [];
    for (const path of paths) {
      try {
        await moveOne(path);
      } catch (error) {
        failed.push({ path, message: message(error) });
      }
    }
    return { failed };
  };
}

/** The trash for this platform. */
export function createTrash(platform: NodeJS.Platform = process.platform): TrashFn {
  if (platform === "win32") return windowsTrash();
  return linuxTrash({
    env: process.env,
    home: homedir(),
    uid: userInfo().uid,
    now: () => new Date(),
  });
}
