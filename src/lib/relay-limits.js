/**
 * Tuning limits for chat relayed between platforms and game consoles.
 *
 * Kept in one module so the queue, the console transport, and the message
 * formatters cannot drift apart from each other.
 */

/** Longest single relayed message, in characters. */
export const MAX_RELAY_CONTENT_LENGTH = 500;

/**
 * Most messages held per server while its console is unavailable. Queued relays
 * are persisted, so an unbounded queue grows the runtime state file and floods
 * the console when the server comes back.
 */
export const MAX_RELAY_QUEUE_LENGTH = 100;

/**
 * Console output window for a relayed chat command, in milliseconds.
 *
 * Relayed chat produces no output we parse, so the 2500ms default used by
 * output-parsing commands only holds the per-server command queue open. A short
 * window still absorbs the console echo so it cannot leak into the next
 * command's captured lines.
 */
export const CHAT_RELAY_CAPTURE_MS = 250;
