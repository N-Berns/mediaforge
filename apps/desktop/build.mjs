// Bundles the app into one file: dist/main.js. JSX is compiled here, and the
// workspace packages (TypeScript sources) are inlined, so `node dist/main.js` just works.
import { build } from "esbuild";

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
  alias: { "react-devtools-core": "./build/empty-module.js" },
  define: { "process.env.NODE_ENV": '"production"', "process.env.DEV": '"false"' },
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
