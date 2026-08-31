import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoots = ["api.ts", "index.ts", "setup-entry.ts", "src"];
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

async function* walk(path, extensions) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      yield* walk(child, extensions);
    } else if (extensions.has(extname(entry.name))) {
      yield child;
    }
  }
}

const sourceFiles = [];
for (const root of sourceRoots) {
  const absolute = join(repoRoot, root);
  if (sourceExtensions.has(extname(root))) {
    sourceFiles.push(absolute);
  } else {
    for await (const file of walk(absolute, sourceExtensions)) {
      sourceFiles.push(file);
    }
  }
}

const sdkSpecifiers = new Set();
const specifierPattern = /["'](openclaw\/plugin-sdk(?:\/[^"']+)*)["']/g;
for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(specifierPattern)) {
    sdkSpecifiers.add(match[1]);
  }
}

const unresolved = [];
for (const specifier of [...sdkSpecifiers].sort()) {
  try {
    import.meta.resolve(specifier);
  } catch (error) {
    unresolved.push({ specifier, error });
  }
}
if (unresolved.length > 0) {
  for (const entry of unresolved) {
    console.error(`Cannot resolve ${entry.specifier}: ${String(entry.error)}`);
  }
  process.exit(1);
}

const distRoot = join(repoRoot, "dist");
const builtModules = [];
for await (const file of walk(distRoot, new Set([".js"]))) {
  builtModules.push(file);
}
builtModules.sort();
if (builtModules.length === 0) {
  throw new Error("No built runtime modules found; run npm run build first");
}

for (const file of builtModules) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Failed to load ${relative(repoRoot, file)}`, { cause: error });
  }
}

for (const entrypoint of ["dist/index.js", "dist/setup-entry.js"]) {
  const loaded = await import(pathToFileURL(join(repoRoot, entrypoint)).href);
  if (!loaded.default) {
    throw new Error(`${entrypoint} has no default export`);
  }
}

console.log(
  `Resolved ${sdkSpecifiers.size} SDK subpaths and loaded ${builtModules.length} built modules successfully.`,
);
