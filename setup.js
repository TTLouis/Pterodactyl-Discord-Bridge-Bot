#!/usr/bin/env node
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m',
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(label, def) {
  return new Promise(resolve => {
    const suffix = def !== undefined ? ` ${C.dim}[${def}]${C.reset}` : '';
    rl.question(`  ${label}${suffix}: `, ans => resolve(ans.trim() || (def ?? '')));
  });
}

async function askRequired(label) {
  for (;;) {
    const val = await ask(label);
    if (val) return val;
    console.log(`${C.red}  This field is required.${C.reset}`);
  }
}

async function askYN(label, def = 'n') {
  const hint = def === 'y' ? 'Y/n' : 'y/N';
  const ans = await ask(`${label} (${hint})`, def);
  return /^y/i.test(ans);
}

async function askInt(label, def) {
  for (;;) {
    const val = await ask(label, String(def));
    const n = parseInt(val, 10);
    if (!isNaN(n) && n > 0) return n;
    console.log(`${C.red}  Must be a positive whole number.${C.reset}`);
  }
}

function section(title) {
  const line = '─'.repeat(Math.max(0, 48 - title.length));
  console.log(`\n${C.bold}${C.cyan}── ${title} ${line}${C.reset}`);
}

function hint(msg) {
  console.log(`  ${C.dim}↳ ${msg}${C.reset}`);
}

const GAME_TYPES = ['factorio', 'minecraft', 'satisfactory'];

async function collectServer(index) {
  console.log(`\n  ${C.bold}Server #${index}${C.reset}`);

  const name = await askRequired('Display name');
  const pterodactylServerId = await askRequired('Pterodactyl server UUID');
  hint('Found in the Pterodactyl panel URL when viewing the server, or under Settings');
  const discordChannelId = await askRequired('Discord channel ID for this server\'s status panel');
  hint('Right-click the channel in Discord → Copy Channel ID (requires Developer Mode)');

  console.log(`\n  Game type:  1) factorio   2) minecraft   3) satisfactory`);
  let gameType = '';
  for (;;) {
    const choice = await ask('Choose (1/2/3)', '1');
    const n = parseInt(choice, 10);
    if (n >= 1 && n <= 3) { gameType = GAME_TYPES[n - 1]; break; }
    if (GAME_TYPES.includes(choice)) { gameType = choice; break; }
    console.log(`${C.red}  Enter 1, 2, or 3.${C.reset}`);
  }

  const game = { type: gameType };

  if (gameType === 'satisfactory') {
    console.log('');
    hint('Satisfactory servers expose an HTTPS API for live player/state data');
    const token = await ask('Satisfactory API bearer token (press Enter to skip)');
    if (token) game.apiToken = token;
    game.allowInsecureTls = await askYN('Allow insecure TLS?', 'y');
    hint('Most self-hosted Satisfactory servers use self-signed certificates');
  }

  console.log('');
  const server = { name, pterodactylServerId, discordChannelId, game };

  const enableAutoStop = await askYN('Enable auto-stop when server is idle?', 'n');
  if (enableAutoStop) {
    const emptyTimeoutHours = await askInt('  Idle timeout before shutdown (hours)', 24);
    const warningMinutesBefore = await askInt('  Warning notice before shutdown (minutes)', 60);
    server.autoStop = { enabled: true, emptyTimeoutHours, warningMinutesBefore };
  } else {
    server.autoStop = { enabled: false };
  }

  return server;
}

async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗`);
  console.log(`║   Pterodactyl Discord Bridge Bot — Setup         ║`);
  console.log(`╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('\nThis wizard creates your .env and servers.json configuration files.\n');

  const envPath = path.join(__dirname, '.env');
  const serversPath = path.join(__dirname, 'servers.json');

  let writeEnv = true;
  let writeServers = true;

  if (fs.existsSync(envPath)) {
    writeEnv = await askYN(`${C.yellow}.env already exists — overwrite it?${C.reset}`, 'n');
    if (!writeEnv) console.log('  Keeping existing .env.');
  }
  if (fs.existsSync(serversPath)) {
    writeServers = await askYN(`${C.yellow}servers.json already exists — overwrite it?${C.reset}`, 'n');
    if (!writeServers) console.log('  Keeping existing servers.json.');
  }

  // ── .env ─────────────────────────────────────────────────────────────────
  let envData = null;
  if (writeEnv) {
    section('.env — Bot credentials');
    hint('Go to https://discord.com/developers/applications → your app → Bot → Reset Token');
    const discordToken = await askRequired('Discord bot token');
    const intervalSecs = await askInt('Panel poll interval (seconds)', 60);
    envData = { DISCORD_TOKEN: discordToken, PANEL_UPDATE_INTERVAL_SECONDS: intervalSecs, CONFIG_PATH: './servers.json', STATE_PATH: './runtime-state.json' };
  }

  // ── servers.json ──────────────────────────────────────────────────────────
  let serversConfig = null;
  if (writeServers) {
    section('servers.json — Discord settings');
    hint('Enable Developer Mode: Discord Settings → Advanced → Developer Mode');
    hint('Then right-click your server or channels and choose "Copy ID"');
    const guildId = await askRequired('Discord server (guild) ID');
    const statusChannelId = await askRequired('Status panel channel ID');
    const logChannelId = await ask('Bot log channel ID (optional, press Enter to skip)');
    const serverAdminRoleId = await ask('Server-admin role ID (optional, press Enter to match by name)');
    const serverAdminRoleName = await ask('Server-admin role name', 'server-admin');
    const displayTimeZone = await ask('Display timezone (IANA, e.g. America/Toronto)', 'America/Toronto');

    section('servers.json — Pterodactyl settings');
    hint('Get your Client API key: Panel → Account Settings → API Credentials → Create');
    const baseUrl = await askRequired('Pterodactyl panel URL (e.g. https://panel.example.com)');
    const apiKey = await askRequired('Pterodactyl client API key');
    const pollIntervalSeconds = await askInt('Pterodactyl poll interval (seconds)', 60);

    section('servers.json — Game servers');
    console.log('\n  Add at least one game server.\n');

    const servers = [];
    servers.push(await collectServer(1));
    while (await askYN('\n  Add another server?', 'n')) {
      servers.push(await collectServer(servers.length + 1));
    }

    const discord = { guildId, statusChannelId, serverAdminRoleName, displayTimeZone };
    if (logChannelId) discord.logChannelId = logChannelId;
    if (serverAdminRoleId) discord.serverAdminRoleId = serverAdminRoleId;

    serversConfig = { discord, pterodactyl: { baseUrl, apiKey, pollIntervalSeconds }, servers };
  }

  // ── Write files ───────────────────────────────────────────────────────────
  if (envData || serversConfig) {
    section('Writing files');
  }

  if (envData) {
    const lines = Object.entries(envData).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(envPath, lines + '\n', 'utf8');
    console.log(`  ${C.green}✔${C.reset} .env written`);
  }

  if (serversConfig) {
    fs.writeFileSync(serversPath, JSON.stringify(serversConfig, null, 2) + '\n', 'utf8');
    console.log(`  ${C.green}✔${C.reset} servers.json written`);
  }

  // ── Next steps ────────────────────────────────────────────────────────────
  section('All done');
  console.log(`\n  ${C.bold}Start the bot:${C.reset}`);
  console.log(`    npm                 ${C.cyan}npm start${C.reset}`);
  console.log(`    Docker Compose      ${C.cyan}docker compose up --build -d${C.reset}`);
  console.log(`    Docker logs         ${C.cyan}docker compose logs -f${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}To reconfigure at any time, run: node setup.js${C.reset}`);
  console.log('');
}

main()
  .then(() => rl.close())
  .catch(err => {
    console.error(`\n${C.red}Setup failed:${C.reset}`, err.message);
    rl.close();
    process.exit(1);
  });
