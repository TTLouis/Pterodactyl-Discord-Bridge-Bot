import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_TEST_FILE_TIMEOUT_MS = 30_000;

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

function resolvePerFileTimeoutMs() {
  const configured = Number(process.env.TEST_FILE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TEST_FILE_TIMEOUT_MS;
}

const testDirectory = path.resolve(process.cwd(), "test");
const testFiles = collectTestFiles(testDirectory).sort();
const timeoutMs = resolvePerFileTimeoutMs();

if (testFiles.length === 0) {
  console.error("No test files found under test/");
  process.exit(1);
}

for (const testFile of testFiles) {
  const relativePath = path.relative(process.cwd(), testFile);
  console.log(`\n=== ${relativePath} ===`);

  const result = spawnSync(process.execPath, ["--test", testFile], {
    stdio: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      console.error(`Test file timed out after ${timeoutMs}ms: ${relativePath}`);
      process.exit(124);
    }
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAll ${testFiles.length} test files passed.`);
