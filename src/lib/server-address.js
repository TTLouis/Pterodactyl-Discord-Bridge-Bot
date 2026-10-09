import { isIP } from "node:net";

/** Accept a hostname or IP, without a scheme, port, or allocation label. */
export function isServerAddress(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (isIP(value)) return true;
  if (value.length > 253) return false;
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  return hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
}
