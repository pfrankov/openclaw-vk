import { rmSync } from "node:fs";
import { build } from "esbuild";

const entryPoints = [
  "index.ts",
  "setup-entry.ts",
  "api.ts",
  "src/accounts.ts",
  "src/channel.setup.ts",
  "src/channel.ts",
  "src/config-schema.ts",
  "src/format.ts",
  "src/inbound.ts",
  "src/keyboard.ts",
  "src/media.ts",
  "src/monitor.ts",
  "src/probe.ts",
  "src/reactions-controller.ts",
  "src/runtime.ts",
  "src/sanitize.ts",
  "src/send-support.ts",
  "src/send.ts",
  "src/setup-core.ts",
  "src/setup-surface.ts",
  "src/types.ts",
];

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints,
  outbase: ".",
  outdir: "dist",
  bundle: false,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "info",
});
