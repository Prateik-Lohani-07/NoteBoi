import esbuild from "esbuild";
import process from "process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const production = process.argv[2] === "production";

// Obsidian loads main.js, manifest.json and styles.css from the plugin's folder.
// Point OBSIDIAN_PLUGIN_DIR at <vault>/.obsidian/plugins/graph-recall to build straight into a vault;
// otherwise output goes to ./dist so the repo root stays free of generated files.
const outDir = process.env.OBSIDIAN_PLUGIN_DIR || "dist";

const copyStatics = {
  name: "copy-statics",
  setup(build) {
    build.onEnd(() => {
      mkdirSync(outDir, { recursive: true });
      for (const f of ["manifest.json", "styles.css"]) copyFileSync(f, join(outDir, f));
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // node platform: picks neo4j-driver's Bolt-over-TCP build (not the browser websocket one)
  platform: "node",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: join(outDir, "main.js"),
  plugins: [copyStatics],
});

if (production) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
