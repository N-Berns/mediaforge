import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrash,
  linuxTrash,
  type TrashRunner,
  WINDOWS_TRASH_SCRIPT,
  windowsTrash,
  windowsTrashCommand,
} from "./trash.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mf-trash-"));
  dirs.push(d);
  return d;
};

describe("windows trash", () => {
  it("runs a fixed hidden PowerShell script and never puts a path on the command line", () => {
    const { command, args } = windowsTrashCommand();
    expect(command).toBe(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    );
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]),
    );
    const encoded = args[args.indexOf("-EncodedCommand") + 1] as string;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(WINDOWS_TRASH_SCRIPT);
  });

  it("hands C# the escape \\0\\0 and PowerShell a literal UNC prefix", () => {
    expect(WINDOWS_TRASH_SCRIPT).toContain('op.pFrom = path + "\\0\\0";');
    expect(WINDOWS_TRASH_SCRIPT).toContain("$p.StartsWith('\\\\')");
  });

  it("sends the paths as base64 JSON on stdin and reads failures back", async () => {
    let seenStdin = "";
    let seenArgs: string[] = [];
    const run: TrashRunner = async (_command, args, stdin) => {
      seenArgs = args;
      seenStdin = stdin;
      const failed = [{ path: "C:\\dl\\ü.mp4", message: "in use" }];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(failed), "utf8").toString("base64"),
        stderr: "",
      };
    };
    const paths = ["C:\\dl\\ü.mp4", "C:\\dl\\b.mp4"];
    const result = await windowsTrash(run)(paths);
    expect(JSON.parse(Buffer.from(seenStdin, "base64").toString("utf8"))).toEqual({
      paths,
      permanent: false,
    });
    expect(seenArgs.join(" ")).not.toContain("dl");
    expect(result.failed).toEqual([{ path: "C:\\dl\\ü.mp4", message: "in use" }]);
  });

  it("sends permanent on stdin and maps the too-large code", async () => {
    let seenStdin = "";
    const run: TrashRunner = async (_command, _args, stdin) => {
      seenStdin = stdin;
      const failed = [
        { path: "C:\\dl\\big.mp4", message: "too big", code: "too-large" },
        { path: "C:\\dl\\b.mp4", message: "in use" },
        { path: "C:\\dl\\c.mp4", message: "odd", code: "something-else" },
      ];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(failed), "utf8").toString("base64"),
        stderr: "",
      };
    };
    const paths = ["C:\\dl\\big.mp4", "C:\\dl\\b.mp4", "C:\\dl\\c.mp4"];
    const result = await windowsTrash(run)(paths, { permanent: true });
    expect(JSON.parse(Buffer.from(seenStdin, "base64").toString("utf8"))).toEqual({
      paths,
      permanent: true,
    });
    expect(result.failed).toEqual([
      { path: "C:\\dl\\big.mp4", message: "too big", code: "too-large" },
      { path: "C:\\dl\\b.mp4", message: "in use" },
      { path: "C:\\dl\\c.mp4", message: "odd" },
    ]);
  });

  it("fails every path when PowerShell cannot run", async () => {
    const run: TrashRunner = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const result = await windowsTrash(run)(["C:\\a", "C:\\b"]);
    expect(result.failed.map((f) => f.path)).toEqual(["C:\\a", "C:\\b"]);
    expect(result.failed[0]?.message).toMatch(/Recycle Bin/);
  });

  it("refuses drives without a Recycle Bin and never deletes for good", () => {
    expect(WINDOWS_TRASH_SCRIPT).toContain("DriveType");
    expect(WINDOWS_TRASH_SCRIPT).toContain("0x0040"); // FOF_ALLOWUNDO
    expect(WINDOWS_TRASH_SCRIPT).toContain("0x0400"); // FOF_NOERRORUI
    expect(WINDOWS_TRASH_SCRIPT).not.toContain("OnlyErrorDialogs");
  });
});

describe("windows trash script guards", () => {
  it("refuses a bin that is off or too small before recycling, and never confirms deletion", () => {
    expect(WINDOWS_TRASH_SCRIPT).toContain("GetVolumeNameForVolumeMountPointW");
    expect(WINDOWS_TRASH_SCRIPT).toContain("NukeOnDelete");
    expect(WINDOWS_TRASH_SCRIPT).toContain("MaxCapacity");
    expect(WINDOWS_TRASH_SCRIPT).toContain("Recycle Bin is turned off for this drive");
    expect(WINDOWS_TRASH_SCRIPT).toContain("is larger than this drive");
    expect(WINDOWS_TRASH_SCRIPT).toContain("$total * 0.05");
    expect(WINDOWS_TRASH_SCRIPT.indexOf("Get-RecycleRefusal $real")).toBeLessThan(
      WINDOWS_TRASH_SCRIPT.indexOf("[MediaForgeTrash]::Recycle($real)"),
    );
  });

  it("keeps real backslashes in the registry paths and the C# escapes", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    expect(script).toContain(
      "$bitBucketVolumes = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'",
    );
    expect(script).toContain("($bitBucketVolumes + '\\' + $guid)");
    expect(script).toContain('op.pFrom = path + "\\0\\0";');
    expect(script).toContain('s.EndsWith("\\\\") ? s : s + "\\\\"');
    expect(script).not.toContain("SoftwareMicrosoft");
    expect(script).not.toContain("BitBucketVolume");
    expect(script).not.toContain("PoliciesExplorer");
  });

  it("fails closed when the volume, its size or its settings cannot be determined", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    // The holding volume (mount points included), not the path root.
    expect(script).toContain("GetVolumePathNameW");
    expect(script).toContain("GetDiskFreeSpaceExW");
    expect(script).toContain("[MediaForgeTrash]::VolumeRoot($real)");
    expect(script).not.toContain("DriveInfo($root");
    // No volume GUID (subst drives) or no size: refuse.
    expect(script).toMatch(/VolumeGuid\(\$root\)\s+if \(-not \$guid\) \{ return \$noBin \}/);
    expect(script).toMatch(/if \(\$total -le 0\) \{ return \$noBin \}/);
    // A key that exists but cannot be read throws into the refusing catch; none falls through.
    expect(script).toContain("$base.OpenSubKey($subKey)");
    expect(script).toContain("if ($null -eq $key) { return $null }");
    expect(script).not.toContain("Get-ItemProperty");
    // Drive type comes from the holding volume's root and must be DRIVE_FIXED.
    expect(script).toContain("[MediaForgeTrash]::DriveType($root) -ne 3");
    expect(script).not.toContain("GetPathRoot");
    expect(script).not.toContain("DriveInfo");
    expect(script).not.toMatch(/catch \{ \}/);
    expect(script).toContain("Could not check this drive");
  });

  it("honors the Explorer policies for the Recycle Bin", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    expect(script).toContain("foreach ($hive in 'HKCU', 'HKLM')");
    expect(script).toContain("'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'");
    expect(script).toContain("$policy.NoRecycleFiles -eq 1");
    expect(script).toContain("$policy.RecycleBinSize");
    expect(script).toContain("$total * $percent / 100");
    expect(script.indexOf("$total * $percent / 100")).toBeLessThan(script.indexOf("$maxMb * 1MB"));
  });

  it("checks and recycles the file's real path, through junctions and folder links", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    expect(script).toContain("CreateFileW(path, 0, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0x02000000");
    expect(script).toContain("GetFinalPathNameByHandleW(h, sb, 32767, 0x0 | 0x0)");
    expect(script).toContain("finally { CloseHandle(h); }");
    expect(script).toContain(
      String.raw`if (s.StartsWith(@"\\?\UNC\")) return @"\\" + s.Substring(8);`,
    );
    expect(script).toContain(String.raw`if (s.StartsWith(@"\\?\")) return s.Substring(4);`);
    // The real path fails closed and is refused when it is a share or not a drive path.
    expect(script).toContain("if (-not $real) { throw");
    expect(script).toContain(
      String.raw`if ($real.StartsWith('\\')) { throw 'This drive has no Recycle Bin`,
    );
    expect(script).toContain(String.raw`if ($real -notmatch '^[A-Za-z]:\\'`);
    expect(script).toContain("GetFullPath($real) -ceq $real");
    // Every check after resolution uses the real path, and so does the recycle.
    const loop = script.slice(script.indexOf("foreach ($p in @($request.paths"));
    const order = [
      "$real = Resolve-RealPath $p",
      "Get-RecycleRefusal $real",
      "[MediaForgeTrash]::Recycle($real)",
    ].map((step) => loop.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(loop).not.toContain("Get-RecycleRefusal $p");
    expect(loop).not.toContain("Recycle($p)");
    const refusal = script.slice(
      script.indexOf("function Get-RecycleRefusal($real)"),
      script.indexOf("$text = "),
    );
    expect(refusal).not.toMatch(/\$p\b/);
    expect(refusal).toContain("Get-Item -LiteralPath $real -Force");
  });

  it("reads the paths and the permanent flag from the stdin object", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    expect(script).toContain("$request = ConvertFrom-Json $text");
    expect(script).toContain(
      "$permanent = ($request.permanent -is [bool]) -and $request.permanent",
    );
    expect(script).toContain("foreach ($p in @($request.paths | ForEach-Object { $_ }))");
  });

  it("deletes for good only a too-large file, only with permanent, after every other refusal", () => {
    const script = WINDOWS_TRASH_SCRIPT;
    const refusal = script.slice(
      script.indexOf("function Get-RecycleRefusal($real)"),
      script.indexOf("$text = "),
    );
    // The size check is the last refusal: drive type, policies and the bin switch come first.
    const size = refusal.indexOf("-gt $cap) { return 'too-large' }");
    expect(size).toBeGreaterThan(0);
    for (const earlier of [
      "DriveType($root) -ne 3",
      "if (-not $guid) { return $noBin }",
      "if ($total -le 0) { return $noBin }",
      "$policy.NoRecycleFiles -eq 1) { return $off }",
      "if ($nuke -eq 1) { return $off }",
      "$cap = [int64]($total * 0.05)",
    ]) {
      const at = refusal.indexOf(earlier);
      expect(at, earlier).toBeGreaterThan(0);
      expect(at, earlier).toBeLessThan(size);
    }
    // The loop: resolution and refusal first; the permanent branch lives only in the too-large case.
    const loop = script.slice(script.indexOf("foreach ($p in @($request.paths"));
    const tooLarge = loop.indexOf("if ($refusal -eq 'too-large') {");
    const otherRefusal = loop.indexOf("if ($refusal) { throw $refusal }");
    const recycle = loop.indexOf("[MediaForgeTrash]::Recycle($real)");
    expect(loop.indexOf("$real = Resolve-RealPath $p")).toBeLessThan(tooLarge);
    expect(loop.indexOf("$refusal = Get-RecycleRefusal $real")).toBeLessThan(tooLarge);
    expect(tooLarge).toBeLessThan(otherRefusal);
    expect(otherRefusal).toBeLessThan(recycle);
    const branch = loop.slice(tooLarge, otherRefusal);
    expect(branch).toContain("if (-not $permanent) {");
    expect(branch).toContain(
      "message = 'The file is larger than this drive''s Recycle Bin; it would be deleted permanently.'; code = 'too-large'",
    );
    expect(branch.indexOf("if (-not $permanent) {")).toBeLessThan(
      branch.indexOf("[System.IO.File]::Delete($real)"),
    );
    expect(branch).toContain("if (Test-Path -LiteralPath $real) { throw");
    // Nothing else in the script deletes for good.
    expect(script.split("[System.IO.File]::Delete(")).toHaveLength(2);
    expect(script).not.toContain("Remove-Item");
    expect(branch).not.toContain("Delete($p)");
  });

  it("requires a fully qualified path before the existence check", () => {
    const qualified = WINDOWS_TRASH_SCRIPT.indexOf("GetFullPath($p) -ceq $p");
    expect(qualified).toBeGreaterThan(0);
    expect(WINDOWS_TRASH_SCRIPT.indexOf("'^[A-Za-z]:\\\\'")).toBeGreaterThan(0);
    expect(qualified).toBeLessThan(
      WINDOWS_TRASH_SCRIPT.indexOf("if (-not (Test-Path -LiteralPath $p))"),
    );
    expect(WINDOWS_TRASH_SCRIPT.indexOf("StartsWith('\\\\')")).toBeLessThan(qualified);
  });
});

describe.runIf(process.platform === "win32")(
  "windows trash, live PowerShell (no real files)",
  () => {
    it("skips missing fully qualified paths, including non-ASCII and [brackets]", async () => {
      const result = await createTrash("win32")([
        "C:\\mf-trash-missing-ü\\clip.mp4",
        "C:\\mf-trash-missing\\clip [x].mp4",
      ]);
      expect(result.failed).toEqual([]);
    }, 30_000);

    it("skips missing paths with permanent too, deleting nothing", async () => {
      const result = await createTrash("win32")(["C:\\mf-trash-missing-ü\\big.mp4"], {
        permanent: true,
      });
      expect(result.failed).toEqual([]);
    }, 30_000);

    it("finds the registry keys the script reads (read-only)", () => {
      for (const name of ["bitBucketVolumes", "explorerPolicies"]) {
        const sub = new RegExp(`\\$${name} = '([^']+)'`).exec(WINDOWS_TRASH_SCRIPT)?.[1];
        expect(sub).toBeTruthy();
        const out = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `Test-Path -LiteralPath 'HKCU:\\${sub}'`],
          { encoding: "utf8" },
        );
        // The bin settings live in HKCU; the policy key may be absent, so only check it parses.
        if (name === "bitBucketVolumes") expect(out.trim()).toBe("True");
        else expect(["True", "False"]).toContain(out.trim());
      }
    }, 30_000);

    it("resolves a file under a directory junction to the junction's target (no recycling)", async () => {
      const root = await temp();
      const target = join(root, "target");
      await mkdir(target);
      await writeFile(join(target, "clip.mp4"), "x");
      // Junctions need no admin rights; both ends stay inside this temp folder.
      await symlink(target, join(root, "link"), "junction");
      const given = join(root, "link", "clip.mp4");
      // Only the definitions run: the script is cut before it reads stdin and recycles anything.
      const definitions = WINDOWS_TRASH_SCRIPT.slice(0, WINDOWS_TRASH_SCRIPT.indexOf("$text = "));
      const probe = `${definitions}
$real = Resolve-RealPath '${given.replaceAll("'", "''")}'
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($real)))`;
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(probe, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] },
      );
      const real = Buffer.from(out.trim(), "base64").toString("utf8");
      expect(real.toLowerCase()).toBe(join(await realpath(target), "clip.mp4").toLowerCase());
      expect(real.toLowerCase()).not.toContain(`${sep}link${sep}`);
      expect(await readFile(join(target, "clip.mp4"), "utf8")).toBe("x");
    }, 30_000);

    it("refuses paths that are not fully qualified, even when they do not exist", async () => {
      const result = await createTrash("win32")(["clip.mp4", "C:clip.mp4", "C:/mf-missing/a.mp4"]);
      expect(result.failed.map((f) => f.path)).toEqual([
        "clip.mp4",
        "C:clip.mp4",
        "C:/mf-missing/a.mp4",
      ]);
    }, 30_000);
  },
);

describe("linux trash", () => {
  // The per-mount folder must belong to this user, so the fake uid is the real one where there is one.
  const uid = process.getuid?.() ?? 1000;
  const deps = (root: string, extra: Partial<Parameters<typeof linuxTrash>[0]> = {}) => ({
    env: { XDG_DATA_HOME: join(root, "data") },
    home: join(root, "home"),
    uid,
    now: () => new Date(2026, 9, 15, 9, 5, 7),
    ...extra,
  });

  it("moves the file into XDG_DATA_HOME/Trash and writes a matching trashinfo", async () => {
    const root = await temp();
    await mkdir(join(root, "dl"), { recursive: true });
    const file = join(root, "dl", "My clip #1.mp4");
    await writeFile(file, "x");

    const result = await linuxTrash(deps(root))([file]);

    expect(result.failed).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
    const trash = join(root, "data", "Trash");
    expect(await readdir(join(trash, "files"))).toEqual(["My clip #1.mp4"]);
    const info = await readFile(join(trash, "info", "My clip #1.mp4.trashinfo"), "utf8");
    expect(info).toBe(
      `[Trash Info]\nPath=${file.split(sep).map(encodeURIComponent).join("/")}\nDeletionDate=2026-10-15T09:05:07\n`,
    );
  });

  it("ignores permanent: there is no size limit, so the file still goes to the trash", async () => {
    const root = await temp();
    const file = join(root, "a.mp4");
    await writeFile(file, "x");
    const result = await linuxTrash(deps(root))([file], { permanent: true });
    expect(result.failed).toEqual([]);
    expect(await readdir(join(root, "data", "Trash", "files"))).toEqual(["a.mp4"]);
  });

  it("falls back to ~/.local/share/Trash without XDG_DATA_HOME", async () => {
    const root = await temp();
    const file = join(root, "a.mp4");
    await writeFile(file, "x");
    await linuxTrash(deps(root, { env: {} }))([file]);
    expect(await readdir(join(root, "home", ".local", "share", "Trash", "files"))).toEqual([
      "a.mp4",
    ]);
  });

  it("gives a second file of the same name a new trash name", async () => {
    const root = await temp();
    const trash = linuxTrash(deps(root));
    for (const n of [1, 2]) {
      await mkdir(join(root, `d${n}`), { recursive: true });
      await writeFile(join(root, `d${n}`, "a.mp4"), String(n));
      await trash([join(root, `d${n}`, "a.mp4")]);
    }
    expect((await readdir(join(root, "data", "Trash", "files"))).sort()).toEqual([
      "a.2.mp4",
      "a.mp4",
    ]);
  });

  it("counts a missing file as already gone", async () => {
    const root = await temp();
    const result = await linuxTrash(deps(root))([join(root, "nope.mp4")]);
    expect(result.failed).toEqual([]);
  });

  it("uses the other mount's .Trash-UID with a path relative to that mount", async () => {
    const root = await temp();
    const mount = join(root, "mnt");
    await mkdir(join(mount, "media"), { recursive: true });
    const file = join(mount, "media", "a.mp4");
    await writeFile(file, "x");
    // Everything under `mount` is device 2; the rest is device 1.
    const deviceOf = async (path: string) => (path.startsWith(mount) ? 2 : 1);

    const result = await linuxTrash(deps(root, { deviceOf }))([file]);

    expect(result.failed).toEqual([]);
    expect(await readdir(join(mount, `.Trash-${uid}`, "files"))).toEqual(["a.mp4"]);
    const info = await readFile(join(mount, `.Trash-${uid}`, "info", "a.mp4.trashinfo"), "utf8");
    expect(info).toContain("Path=media/a.mp4\n");
  });

  it("reports a file it cannot move and still moves the others", async () => {
    const root = await temp();
    await mkdir(join(root, "dir.mp4"));
    const ok = join(root, "ok.mp4");
    await writeFile(ok, "x");
    const result = await linuxTrash(deps(root))([join(root, "dir.mp4"), ok]);
    expect(result.failed.map((f) => f.path)).toEqual([join(root, "dir.mp4")]);
    await expect(stat(ok)).rejects.toThrow();
  });

  it("does not overwrite an orphan in files/ that has no trashinfo", async () => {
    const root = await temp();
    const trash = join(root, "data", "Trash");
    await mkdir(join(trash, "files"), { recursive: true });
    await writeFile(join(trash, "files", "a.mp4"), "orphan");
    const file = join(root, "a.mp4");
    await writeFile(file, "new");

    const result = await linuxTrash(deps(root))([file]);

    expect(result.failed).toEqual([]);
    expect(await readFile(join(trash, "files", "a.mp4"), "utf8")).toBe("orphan");
    expect(await readFile(join(trash, "files", "a.2.mp4"), "utf8")).toBe("new");
    expect((await readdir(join(trash, "info"))).sort()).toEqual(["a.2.mp4.trashinfo"]);
  });

  it("picks the trash by the folder holding the file, not by a link's target", async () => {
    const root = await temp();
    const mount = join(root, "mnt");
    await mkdir(join(mount, "media"), { recursive: true });
    const file = join(mount, "media", "a.mp4");
    await writeFile(file, "x");
    // The file itself reports device 1 (like a link to another mount); its folder is device 2.
    const deviceOf = async (path: string) => (path === file ? 1 : path.startsWith(mount) ? 2 : 1);

    const result = await linuxTrash(deps(root, { deviceOf }))([file]);

    expect(result.failed).toEqual([]);
    expect(await readdir(join(mount, `.Trash-${uid}`, "files"))).toEqual(["a.mp4"]);
  });

  it.skipIf(process.platform === "win32")(
    "trashes a dangling symlink beside its folder",
    async () => {
      const root = await temp();
      const link = join(root, "link.mp4");
      await symlink(join(root, "gone.mp4"), link);

      const result = await linuxTrash(deps(root))([link]);

      expect(result.failed).toEqual([]);
      expect(await readdir(join(root, "data", "Trash", "files"))).toEqual(["link.mp4"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a per-mount trash folder that is a symlink",
    async () => {
      const root = await temp();
      const mount = join(root, "mnt");
      const elsewhere = join(root, "elsewhere");
      await mkdir(join(mount, "media"), { recursive: true });
      await mkdir(elsewhere);
      await symlink(elsewhere, join(mount, `.Trash-${uid}`));
      const file = join(mount, "media", "a.mp4");
      await writeFile(file, "x");
      const deviceOf = async (path: string) => (path.startsWith(mount) ? 2 : 1);

      const result = await linuxTrash(deps(root, { deviceOf }))([file]);

      expect(result.failed).toEqual([
        { path: file, message: "The trash folder on this drive is not safe to use." },
      ]);
      expect(await readFile(file, "utf8")).toBe("x");
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );
});
