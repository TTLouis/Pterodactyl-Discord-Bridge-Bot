import fs from "node:fs";
import path from "node:path";

const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./servers.json");
if (fs.existsSync(configPath)) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
const initialConfig = {
  discord: {},
  pterodactyl: {},
  features: {
    gameChatRelayEnabled: false
  },
  servers: []
};

fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600
});
console.log(`Created bootstrap configuration at ${configPath}`);
