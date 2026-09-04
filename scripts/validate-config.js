import { getConfigPath, loadConfig } from "../src/lib/config.js";

try {
  loadConfig({ requireRuntimeTokens: false });
  console.log(`Configuration is valid: ${getConfigPath()}`);
} catch (error) {
  console.error(`Configuration is invalid: ${error.message}`);
  process.exitCode = 1;
}
