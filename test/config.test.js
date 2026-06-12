import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDescription, resolvePollingInterval } from "../src/lib/config.js";

test("descriptionLines takes precedence and preserves authored lines", () => {
  assert.equal(normalizeDescription({
    description: "legacy",
    descriptionLines: ["**Heading**", "", "中文说明"]
  }), "**Heading**\n\n中文说明");
});

test("descriptionLines preserves intentional spacing", () => {
  assert.equal(normalizeDescription({
    descriptionLines: ["  indented", "", "trailing  "]
  }), "  indented\n\ntrailing  ");
});

test("legacy description strings remain supported", () => {
  assert.equal(normalizeDescription({ description: "  Legacy description  " }), "Legacy description");
});

test("servers.json polling intervals take precedence over legacy environment values", () => {
  assert.equal(resolvePollingInterval(300, "60", 60), 300);
});

test("legacy polling environment values remain a fallback", () => {
  assert.equal(resolvePollingInterval(undefined, "120", 60), 120);
});
