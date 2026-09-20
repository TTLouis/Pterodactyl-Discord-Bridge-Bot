import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(absolutePath);
    }
  }

  return files;
}

const testDirectory = path.resolve(process.cwd(), "test");
const testFiles = collectTestFiles(testDirectory).sort();

if (testFiles.length === 0) {
  console.error("No test files found under test/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
