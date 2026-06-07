import { describe, expect, it } from "vitest";
import { settingsRegistry } from "./settings-registry";
import { createAppSettings } from "./testing/factories";

describe("settingsRegistry → AppSettings", () => {
  it("every typed registry key exists as an AppSettings key", () => {
    const appSettingsKeys = new Set(Object.keys(createAppSettings()));
    const knownNonAppSettingsKeys = new Set<string>(["llmPurposeApiKeys"]);
    const typedKeys = (
      Object.keys(settingsRegistry) as Array<keyof typeof settingsRegistry>
    ).filter((k) => settingsRegistry[k].kind === "typed");

    const missing: string[] = [];
    for (const key of typedKeys) {
      if (knownNonAppSettingsKeys.has(key as string)) continue;
      if (!appSettingsKeys.has(key as string)) {
        missing.push(key as string);
      }
    }

    expect(
      missing,
      missing.length > 0
        ? `Keys in settingsRegistry typed entries but missing from AppSettings:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
