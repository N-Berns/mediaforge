// Bundles the app into one file: dist/main.js. JSX is compiled here, and the
// workspace packages (TypeScript sources) are inlined, so `node dist/main.js` just works.
import { build } from "esbuild";

// The release workflow sets MEDIAFORGE_VERSION from the git tag, so the binary reports its release.
const version = process.env.MEDIAFORGE_VERSION;

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
  // Ink can load React devtools when DEV is "true". That package is optional and absent here, so
  // point it at an empty module and switch the branch off.
  alias: { "react-devtools-core": "./shims/empty-module.js" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.DEV": '"false"',
    ...(version && { __MEDIAFORGE_VERSION__: JSON.stringify(version) }),
  },
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
