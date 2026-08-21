/**
 * Invokes every registered handler for a platform event, isolating failures.
 *
 * Platform bridges dispatch these from async gateway listeners, where a rejected
 * promise becomes an unhandled rejection rather than something a caller can catch.
 * One failing handler must not skip the rest or take the process down.
 */
export async function runHandlers(handlers, payload, { logger, label } = {}) {
  for (const handler of handlers) {
    try {
      await handler(payload);
    } catch (error) {
      logger?.error(`Failed handling ${label ?? "platform event"}`, error);
    }
  }
}
