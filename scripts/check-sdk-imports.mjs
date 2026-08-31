import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scanRoots = ["api.ts", "index.ts", "setup-entry.ts", "src"];
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

const forbiddenImports = new Map([
  ["openclaw/plugin-sdk", "use a focused openclaw/plugin-sdk/<subpath> import"],
  ["openclaw/plugin-sdk/channel-runtime", "use openclaw/plugin-sdk/channel-outbound"],
  ["openclaw/plugin-sdk/channel-reply-pipeline", "use openclaw/plugin-sdk/channel-outbound"],
  ["openclaw/plugin-sdk/command-auth", "use openclaw/plugin-sdk/command-auth-native"],
  ["openclaw/plugin-sdk/config-runtime", "use focused config/runtime subpaths"],
  [
    "openclaw/plugin-sdk/conversation-runtime",
    "use the account-scoped channel pairing controller for pairing",
  ],
  ["openclaw/plugin-sdk/compat", "use focused SDK subpaths"],
  ["openclaw/extension-api", "use the injected plugin runtime"],
]);

const legacyMediaFields = [
  "MediaPath",
  "MediaUrl",
  "MediaType",
  "MediaPaths",
  "MediaUrls",
  "MediaTypes",
  "MediaTranscribedIndexes",
  "MediaWorkspaceDir",
  "MediaStaged",
];

async function* walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      yield* walk(child);
    } else if (sourceExtensions.has(extname(entry.name))) {
      yield child;
    }
  }
}

async function collectSourceFiles() {
  const files = [];
  for (const scanRoot of scanRoots) {
    const absolute = join(repoRoot, scanRoot);
    if (sourceExtensions.has(extname(scanRoot))) {
      files.push(absolute);
      continue;
    }
    for await (const file of walk(absolute)) {
      files.push(file);
    }
  }
  return files;
}

const violations = [];
for (const file of await collectSourceFiles()) {
  const path = relative(repoRoot, file).replaceAll("\\", "/");
  const lines = (await readFile(file, "utf8")).split("\n");
  for (const [specifier, replacement] of forbiddenImports) {
    const doubleQuoted = `"${specifier}"`;
    const singleQuoted = `'${specifier}'`;
    lines.forEach((line, index) => {
      if (line.includes(doubleQuoted) || line.includes(singleQuoted)) {
        violations.push({ path, line: index + 1, token: specifier, replacement });
      }
    });
  }
  lines.forEach((line, index) => {
    for (const field of legacyMediaFields) {
      if (new RegExp("\\b" + field + "\\s*:").test(line)) {
        violations.push({
          path,
          line: index + 1,
          token: field,
          replacement: "pass ordered facts through the lowercase media field",
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Forbidden OpenClaw compatibility usage found:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line}: ${violation.token}; ${violation.replacement}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("OpenClaw SDK compatibility guard passed.");
}
