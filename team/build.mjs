import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FINANCE_DASHBOARD_STYLES } from "../src/finance-dashboard-styles.js";
import { WORKBENCH_POLISH_CSS } from "../src/workflow-tools-styles.js";
await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: ["src/server.ts", "src/worker.ts", "src/admin.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist",
  sourcemap: true,
});
await build({
  entryPoints: ["web/app.tsx"],
  bundle: true,
  platform: "browser",
  nodePaths: [path.resolve("node_modules")],
  format: "esm",
  target: "es2022",
  outdir: "dist/web",
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  alias: {
    react: "preact/compat",
    "react-dom/client": "preact/compat/client",
    "react/jsx-runtime": "preact/jsx-runtime",
  },
  plugins: [
    {
      name: "team-server-storage",
      setup(b) {
        b.onResolve({ filter: /finance-storage\.js$/ }, () => ({
          path: path.resolve("web/server-store.ts"),
        }));
      },
    },
  ],
});
const base = (
  await readFile("../scripts/build-workbuddy-app.mjs", "utf8")
).match(/const baseStyles = `([\s\S]*?)`/)[1];
// Management controls must not change the layout of the shared original dashboard.
await writeFile(
  "dist/web/app.css",
  "@scope (.team-panels, .login) {\n" +
    (await readFile("dist/web/app.css", "utf8")) +
    "\n}\n" +
    (await readFile("web/auth.css", "utf8")),
);
await writeFile(
  "dist/web/original.css",
  base +
    FINANCE_DASHBOARD_STYLES +
    WORKBENCH_POLISH_CSS +
    (await readFile("web/team-frame.css", "utf8")),
);
await writeFile(
  "dist/web/index.html",
  (await readFile("web/index.html", "utf8")).replace(
    "</head>",
    '<link rel="stylesheet" href="/original.css"></head>',
  ),
);
