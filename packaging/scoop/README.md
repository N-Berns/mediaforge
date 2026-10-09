# Scoop

`mediaforge.json` is the Scoop manifest. Scoop installs from a bucket (a git repo), so publish it
in its own repo, for example `N-Berns/scoop-mediaforge`, with the file at `bucket/mediaforge.json`.

```powershell
scoop bucket add mediaforge https://github.com/N-Berns/scoop-mediaforge
scoop install mediaforge
```

Test locally before publishing: `scoop install .\packaging\scoop\mediaforge.json`.

On a new release, Scoop's `checkver`/`autoupdate` read the tag and the release's `SHA256SUMS`.
Run `.\bin\checkver.ps1 mediaforge -u` from a Scoop bucket checkout to bump the manifest.
