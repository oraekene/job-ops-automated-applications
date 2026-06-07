import { describe, expect, it } from "vitest";
import { settingsRegistry } from "../settings-registry";
import { createAppSettings } from "../testing/factories";

describe("AppSettings → settingsRegistry", () => {
  it("every typed-settings AppSettings key exists as a typed registry entry", () => {
    const appSettingsSample = createAppSettings();
    const registryTypedKeys = new Set(
      (
        Object.keys(settingsRegistry) as Array<keyof typeof settingsRegistry>
      ).filter((k) => settingsRegistry[k].kind === "typed"),
    );

    const knownNonRegistryKeys = new Set([
      "modelScorer",
      "modelTailoring",
      "modelProjectSelection",
      "rxresumeBaseResumeId",
      "rxresumeUrl",
      "ukvisajobsEmail",
      "adzunaAppId",
      "llmApiKeyHint",
      "llmPurposeApiKeyHints",
      "rxresumeApiKeyHint",
      "ukvisajobsPasswordHint",
      "adzunaAppKeyHint",
      "apifyTokenHint",
      "webhookSecretHint",
      "profileProjects",
    ]);

    const missing: string[] = [];
    for (const key of Object.keys(appSettingsSample)) {
      if (knownNonRegistryKeys.has(key)) continue;
      if (!registryTypedKeys.has(key)) {
        missing.push(key);
      }
    }

    expect(
      missing,
      missing.length > 0
        ? `Keys in AppSettings but missing from settingsRegistry typed entries:\n  ${missing.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });
});
