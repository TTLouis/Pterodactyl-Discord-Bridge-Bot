/**
 * Exponential reconnect backoff with jitter, shared by the Pterodactyl console
 * socket and the KOOK gateway.
 *
 * A fixed retry delay means that while a remote is down every socket retries in
 * lockstep, forever, at the same rate. Backing off caps the request rate and the
 * jitter keeps several servers from reconnecting in the same instant.
 */
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;

const JITTER_RATIO = 0.2;

export function nextReconnectDelayMs(baseDelayMs, attempt, {
  maxDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
  random = Math.random
} = {}) {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}
