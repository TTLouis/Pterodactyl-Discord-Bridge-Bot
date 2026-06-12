import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDescription } from "../src/lib/config.js";

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
