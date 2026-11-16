import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  target: "es2021",
  bundle: true,
  minify: true,
  // Extensions must use the CodeMirror instances supplied by Obsidian.
  external: ["obsidian", "@codemirror/*"]
});
