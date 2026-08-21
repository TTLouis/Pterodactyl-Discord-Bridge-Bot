import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_RECONNECT_DELAY_MS, nextReconnectDelayMs } from "../src/lib/reconnect-backoff.js";

const noJitter = () => 0.5;

test("delay doubles with each attempt", () => {
  const delays = [0, 1, 2, 3].map((attempt) => nextReconnectDelayMs(5000, attempt, { random: noJitter }));
  assert.deepEqual(delays, [5000, 10000, 20000, 40000]);
});

test("delay is capped so a long outage does not schedule absurd waits", () => {
  const delay = nextReconnectDelayMs(5000, 30, { random: noJitter });
  assert.equal(delay, DEFAULT_MAX_RECONNECT_DELAY_MS);
});

test("jitter stays within twenty percent of the base delay", () => {
  for (const random of [() => 0, () => 1, () => 0.25, () => 0.75]) {
    const delay = nextReconnectDelayMs(5000, 1, { random });
    assert.ok(delay >= 8000 && delay <= 12000, `expected 10000 +/- 20%, got ${delay}`);
  }
});

test("jitter spreads reconnects in both directions", () => {
  const low = nextReconnectDelayMs(5000, 0, { random: () => 0 });
  const high = nextReconnectDelayMs(5000, 0, { random: () => 1 });
  assert.equal(low, 4000);
  assert.equal(high, 6000);
});

test("a negative attempt is treated as the first attempt", () => {
  assert.equal(nextReconnectDelayMs(5000, -3, { random: noJitter }), 5000);
});
