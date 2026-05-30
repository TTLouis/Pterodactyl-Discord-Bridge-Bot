# Bootstrap Scripts (Experimental)

> **These scripts are not fully tested yet. Use them at your own risk. The recommended setup path is cloning the repository and running `npm run setup`.**

The bootstrap scripts are intended for fresh installs on a new machine where you do not have the repository yet.

## Usage

On Linux or macOS:

```bash
curl -fsSL https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.sh -o bootstrap.sh && bash bootstrap.sh
```

Do not prefix with `sudo`. Run as your normal user so downloaded and generated files are owned by your account.

On Windows PowerShell:

```powershell
Invoke-WebRequest -Uri https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.ps1 -OutFile bootstrap.ps1 -ErrorAction SilentlyContinue; if ($?) { powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 } else { Write-Host "Bootstrap download failed. Install Node.js 20+ and npm, then try again." -ForegroundColor Red }
```

## What the Scripts Do

- Check for Node.js 20+, npm, and archive extraction support
- Offer to install missing tools
- Warn if Docker or Docker Compose is missing (they do not install Docker for you)
- Download and extract the latest source from `main`
- Install dependencies
- Run the interactive setup wizard

## Releasing Bootstrap Scripts

The bootstrap scripts are published as GitHub Release assets so users get stable `releases/latest/download/...` URLs.

Before creating a release:

- Confirm `bootstrap.sh`, `bootstrap.ps1`, `setup.js`, `package.json`, and `package-lock.json` are committed
- Update the version in `package.json`
- Do not commit `.env`, `servers.json`, or `runtime-state.json`
- Test the wizard locally with `npm run setup`

Create and publish a release with GitHub CLI:

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 bootstrap.sh bootstrap.ps1 --title "v0.1.0" --notes "Setup helper scripts are attached for fresh installs."
```

After publishing, verify these URLs resolve:

```
https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.sh
https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.ps1
```

## Branch Model

`main` is the single long-lived branch. Pushing to `main` triggers the self-hosted deployment workflow.

### Self-Hosted Runner Safety

Treat push access to `main` as trusted access to the deployment VM.

Recommended safeguards:

- Keep `.env`, `servers.json`, and `runtime-state.json` out of git
- Keep production tokens off the VM
- Use a dedicated low-privilege VM or container for the runner
- Rotate Discord, Pterodactyl, and Satisfactory tokens before going public if there is any chance they were pasted into a commit, issue, PR, or log
