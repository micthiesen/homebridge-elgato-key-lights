import { describe, expect, it } from "vitest";
import { clampColorTemperature } from "../../src/config/constants.js";
describe("HomeKit color conversion boundary", () => {
  it.each([
    [140, 143],
    [143, 143],
    [200, 200],
    [344, 344],
    [400, 344],
  ])("clamps device mirek %s to %s", (input, output) =>
    expect(clampColorTemperature(input)).toBe(output),
  );
});
