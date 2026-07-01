import path from "node:path";

export function isKookEnabled(value = process.env.KOOK_ENABLED) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function normalizeKookConfigId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (
    !normalized
    || normalized.startsWith("YOUR_")
    || normalized.startsWith("OPTIONAL_")
    || normalized.includes("_KOOK_")
  ) {
    return null;
  }

  return normalized;
}

export function requireKookEnabled() {
  if (!isKookEnabled()) {
    throw new Error("KOOK is disabled. Set KOOK_ENABLED=true in .env to run KOOK tests or future KOOK bridge functions.");
  }
}

export function getKookStatePath() {
  return path.resolve(process.cwd(), process.env.KOOK_STATE_PATH ?? "./kook-runtime-state.json");
}
