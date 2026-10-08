# Deferred: explicit variant support in the download engine

Removed from the desktop CLI because only browser-extension candidates carry
`variants`; the CLI never sets `variantId`. Restore this when the extension
integration work starts.

## What it did

When a `DownloadRequest` has a `variantId` that matches one of
`candidate.variants`, the engine downloaded that variant's direct `url` (if it
had one) and capped the height at that variant's `height`, instead of using the
candidate URL and the profile's `maxHeight`.

## Code (apps/desktop/src/engine/args.ts, in `buildYtDlpArgs`)

Replace

```ts
const url = request.candidate.url;
const maxHeight = profile.maxHeight;
```

with

```ts
const variant = request.variantId
  ? request.candidate.variants.find((v) => v.id === request.variantId)
  : undefined;
const url = variant?.url ?? request.candidate.url;
const maxHeight = variant?.height ?? profile.maxHeight;
```

## Test (apps/desktop/src/engine/engine-parts.test.ts)

Give the `candidate` fixture these variants:

```ts
variants: [
  { id: "v720", label: "720p", height: 720, hasVideo: true, hasAudio: true },
  {
    id: "vdirect",
    label: "direct",
    height: 480,
    hasVideo: true,
    hasAudio: true,
    url: "https://cdn.example.com/480.mp4",
  },
],
```

and add this test inside `describe("buildYtDlpArgs", ...)`:

```ts
it("uses an explicit variant's height and direct url", () => {
  const args = build("best", { variantId: "vdirect" });
  expect(args.at(-1)).toBe("https://cdn.example.com/480.mp4");
  expect(args[args.indexOf("-f") + 1]).toBe("bv*[height<=480]+ba/b[height<=480]");
});
```
