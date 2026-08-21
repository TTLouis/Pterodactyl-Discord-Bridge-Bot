import assert from "node:assert/strict";
import test from "node:test";
import { runHandlers } from "../src/lib/run-handlers.js";

function createLogger() {
  const errors = [];
  return { errors, error(message, meta) { errors.push({ message, meta }); } };
}

test("a throwing handler does not prevent later handlers from running", async () => {
  const calls = [];
  const logger = createLogger();
  const failure = new Error("handler exploded");

  await runHandlers(
    [
      async () => { calls.push("first"); },
      async () => { throw failure; },
      async () => { calls.push("third"); }
    ],
    { channelId: "abc" },
    { logger, label: "test event" }
  );

  assert.deepEqual(calls, ["first", "third"]);
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].message, "Failed handling test event");
  assert.equal(logger.errors[0].meta, failure);
});

test("handler failures are contained rather than rejected to the caller", async () => {
  const logger = createLogger();
  await assert.doesNotReject(() => runHandlers(
    [async () => { throw new Error("boom"); }],
    {},
    { logger, label: "test event" }
  ));
});

test("every handler receives the same payload", async () => {
  const payload = { channelId: "abc" };
  const seen = [];
  await runHandlers([
    async (value) => { seen.push(value); },
    async (value) => { seen.push(value); }
  ], payload, { logger: createLogger(), label: "test event" });

  assert.deepEqual(seen, [payload, payload]);
});

test("a missing logger is tolerated", async () => {
  await assert.doesNotReject(() => runHandlers(
    [async () => { throw new Error("boom"); }],
    {},
    {}
  ));
});
