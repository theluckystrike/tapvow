import { chmodSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

const banner =
  "#!/usr/bin/env -S node --no-warnings=ExperimentalWarning\n" +
  'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: banner },
  logLevel: "info",
});

chmodSync("dist/cli.js", 0o755);
