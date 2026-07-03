import { test } from "node:test";
import assert from "node:assert/strict";
import { readableWorldWandererLocationText } from "../../../../src/capabilities/tools/location/src/index.js";

test("readableWorldWandererLocationText formats the visible address and record date", () => {
  assert.equal(
    readableWorldWandererLocationText({
      formattedAddress: "Ayasofya Meydani, Istanbul, Turkiye",
      date: "2020-08"
    }),
    "Ayasofya Meydani, Istanbul, Turkiye\nRecord date: 2020-08"
  );
});

test("readableWorldWandererLocationText uses address component names when no formatted address exists", () => {
  assert.equal(
    readableWorldWandererLocationText({
      addressComponents: [
        { longName: "Ayasofya Meydani" },
        { short_name: "TR" },
        { longName: "Ayasofya Meydani" }
      ],
      date: "2020-08"
    }),
    "Ayasofya Meydani, TR\nRecord date: 2020-08"
  );
});
