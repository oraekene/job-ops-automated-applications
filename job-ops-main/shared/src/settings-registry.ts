import { z } from "zod";
import {
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
} from "./location-preferences";
import { getDefaultPromptTemplate } from "./prompt-template-definitions";
import {
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
  type ChatStyleLanguageMode,
  type ChatStyleManualLanguage,
  LLM_PROVIDER_VALUES,
  LLM_PURPOSE_VALUES,
  type LlmProviderId,
  type LlmPurpose,
  type LlmPurposeApiKeys,
  type LlmPurposeOverrides,
  PDF_RENDERER_VALUES,
  type PdfRenderer,
  type ResumeProjectsSettings,
  TYPST_THEME_VALUES,
  type TypstTheme,
} from "./types/settings";

function parseNonEmptyStringOrNull(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseJsonArrayOrNull(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseBitBoolOrNull(raw: string | undefined): boolean | null {
  if (!raw) return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function normalizeLlmProviderOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  return normalized ? normalized : null;
}

export const DEFAULT_GEMINI_MODEL = "google/gemini-3-flash-preview";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_CODEX_MODEL = "";

export function getDefaultModelForProvider(
  provider: string | null | undefined,
  fallbackModel?: string | null,
): string {
  const trimmedFallback = fallbackModel?.trim();
  if (trimmedFallback) {
    return trimmedFallback;
  }

  const normalizedProvider = normalizeLlmProviderOrNull(provider ?? undefined);

  if (normalizedProvider === "openai") {
    return DEFAULT_OPENAI_MODEL;
  }

  if (normalizedProvider === "gemini" || normalizedProvider === "gemini_cli") {
    return DEFAULT_GEMINI_MODEL;
  }

  if (normalizedProvider === "codex") {
    return DEFAULT_CODEX_MODEL;
  }
  return DEFAULT_GEMINI_MODEL;
}

function serializeNullableNumber(
  value: number | null | undefined,
): string | null {
  return value !== null && value !== undefined ? String(value) : null;
}

function serializeNullableJsonArray(
  value: string[] | null | undefined,
): string | null {
  return value !== null && value !== undefined ? JSON.stringify(value) : null;
}

function serializeBitBool(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "1" : "0";
}

function isLlmPurpose(value: string): value is LlmPurpose {
  return (LLM_PURPOSE_VALUES as readonly string[]).includes(value);
}

function isLlmProviderId(value: string): value is LlmProviderId {
  return (LLM_PROVIDER_VALUES as readonly string[]).includes(value);
}

function parseTypstThemeOrNull(raw: string | undefined): TypstTheme | null {
  if (!raw) return null;
  if (!(TYPST_THEME_VALUES as readonly string[]).includes(raw)) return null;
  return raw as TypstTheme;
}

function serializeTypstTheme(
  value: TypstTheme | string | null | undefined,
): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!(TYPST_THEME_VALUES as readonly string[]).includes(value)) return null;
  return value;
}

function parseJsonObjectOrNull(
  raw: string | undefined,
): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseLlmPurposeApiKeysOrNull(
  raw: string | undefined,
): LlmPurposeApiKeys | null {
  const obj = parseJsonObjectOrNull(raw);
  if (obj === null) return null;
  const result: LlmPurposeApiKeys = {};
  for (const key of Object.keys(obj)) {
    if (!isLlmPurpose(key)) return null;
    const value = obj[key];
    if (value === null) continue;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) continue;
    result[key] = trimmed;
  }
  return result;
}

function serializeLlmPurposeApiKeys(
  value: LlmPurposeApiKeys | null | undefined,
): string | null {
  if (!value) return null;
  const filtered: LlmPurposeApiKeys = {};
  let hasValid = false;
  for (const purpose of LLM_PURPOSE_VALUES) {
    const v = value[purpose];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    filtered[purpose] = trimmed;
    hasValid = true;
  }
  return hasValid ? JSON.stringify(filtered) : null;
}

function parseLlmPurposeOverridesOrNull(
  raw: string | undefined,
): LlmPurposeOverrides | null {
  const obj = parseJsonObjectOrNull(raw);
  if (obj === null) return null;
  const result: LlmPurposeOverrides = {};
  for (const key of Object.keys(obj)) {
    if (!isLlmPurpose(key)) return null;
    const rawValue = obj[key];
    if (rawValue === null) continue;
    if (typeof rawValue !== "object" || Array.isArray(rawValue)) return null;
    const entry: {
      provider?: LlmProviderId;
      baseUrl?: string;
      model?: string;
    } = {};
    let entryHasValid = false;
    const entryObj = rawValue as Record<string, unknown>;
    if (Object.hasOwn(entryObj, "provider")) {
      const v = entryObj.provider;
      if (v === null) {
        // null clears the provider override
      } else if (typeof v !== "string") {
        return null;
      } else {
        const normalized = v.trim().toLowerCase().replace(/-/g, "_");
        if (normalized) {
          if (!isLlmProviderId(normalized)) return null;
          entry.provider = normalized;
          entryHasValid = true;
        }
      }
    }
    if (Object.hasOwn(entryObj, "baseUrl")) {
      const v = entryObj.baseUrl;
      if (v === null) {
        // null clears the baseUrl override
      } else if (typeof v !== "string") {
        return null;
      } else {
        const trimmed = v.trim();
        if (trimmed) {
          entry.baseUrl = trimmed;
          entryHasValid = true;
        }
      }
    }
    if (Object.hasOwn(entryObj, "model")) {
      const v = entryObj.model;
      if (v === null) {
        // null clears the model override
      } else if (typeof v !== "string") {
        return null;
      } else {
        const trimmed = v.trim();
        if (trimmed) {
          entry.model = trimmed;
          entryHasValid = true;
        }
      }
    }
    if (entryHasValid) {
      result[key] = entry;
    }
  }
  return result;
}

function serializeLlmPurposeOverrides(
  value: LlmPurposeOverrides | null | undefined,
): string | null {
  if (!value) return null;
  const filtered: LlmPurposeOverrides = {};
  let hasValid = false;
  for (const purpose of LLM_PURPOSE_VALUES) {
    const v = value[purpose];
    if (typeof v !== "object" || v === null) continue;
    let entryHasValid = false;
    const entry: {
      provider?: LlmProviderId;
      baseUrl?: string;
      model?: string;
    } = {};
    if (typeof v.provider === "string" && v.provider.trim()) {
      entry.provider = v.provider.trim() as LlmProviderId;
      entryHasValid = true;
    }
    if (typeof v.baseUrl === "string" && v.baseUrl.trim()) {
      entry.baseUrl = v.baseUrl.trim();
      entryHasValid = true;
    }
    if (typeof v.model === "string" && v.model.trim()) {
      entry.model = v.model.trim();
      entryHasValid = true;
    }
    if (entryHasValid) {
      filtered[purpose] = entry;
      hasValid = true;
    }
  }
  return hasValid ? JSON.stringify(filtered) : null;
}

function createEnumParser<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
): (raw: string | undefined) => TValues[number] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number] | null => {
    if (!raw) return null;
    return allowedValues.has(raw) ? (raw as TValues[number]) : null;
  };
}

function createEnumArrayParser<
  const TValues extends readonly [string, ...string[]],
>(values: TValues): (raw: string | undefined) => TValues[number][] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number][] | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;

      const out: TValues[number][] = [];
      const seen = new Set<string>();
      for (const value of parsed) {
        if (typeof value !== "string" || !allowedValues.has(value)) {
          return null;
        }
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value as TValues[number]);
      }
      if (out.length === 0) return null;
      return out;
    } catch {
      return null;
    }
  };
}

const parseChatStyleLanguageModeOrNull = createEnumParser(
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
);

const parseChatStyleManualLanguageOrNull = createEnumParser(
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
);
const parsePdfRendererOrNull = createEnumParser(PDF_RENDERER_VALUES);

const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;
const parseWorkplaceTypesOrNull = createEnumArrayParser(WORKPLACE_TYPE_VALUES);
const parseLocationSearchScopeOrNull = createEnumParser(
  LOCATION_SEARCH_SCOPE_VALUES,
);
const parseLocationMatchStrictnessOrNull = createEnumParser(
  LOCATION_MATCH_STRICTNESS_VALUES,
);

export const resumeProjectsSchema = z.object({
  maxProjects: z.number().int().min(0).max(100),
  lockedProjectIds: z.array(z.string().trim().min(1)).max(200),
  aiSelectableProjectIds: z.array(z.string().trim().min(1)).max(200),
});

export const settingsRegistry = {
  // --- Typed Settings ---
  model: {
    kind: "typed" as const,
    schema: z.string().trim().max(200),
    default: (): string =>
      typeof process !== "undefined"
        ? getDefaultModelForProvider(
            process.env.LLM_PROVIDER,
            process.env.MODEL,
          )
        : DEFAULT_GEMINI_MODEL,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmProvider: {
    kind: "typed" as const,
    envKey: "LLM_PROVIDER",
    schema: z.preprocess(
      (v) => (typeof v === "string" ? normalizeLlmProviderOrNull(v) : v),
      z
        .enum([
          "openrouter",
          "lmstudio",
          "ollama",
          "openai",
          "openai_compatible",
          "gemini",
          "gemini_cli",
          "codex",
        ])
        .nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined"
        ? normalizeLlmProviderOrNull(process.env.LLM_PROVIDER) || "openrouter"
        : "openrouter",
    parse: normalizeLlmProviderOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmBaseUrl: {
    kind: "typed" as const,
    envKey: "LLM_BASE_URL",
    schema: z.preprocess(
      (v) => (v === "" ? null : v),
      z.string().trim().url().max(2000).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined" ? process.env.LLM_BASE_URL || "" : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmPurposeApiKeys: {
    kind: "typed" as const,
    envKey: "LLM_PURPOSE_API_KEYS",
    schema: z.record(z.string().nullable()),
    default: (): LlmPurposeApiKeys => ({}),
    parse: parseLlmPurposeApiKeysOrNull,
    serialize: serializeLlmPurposeApiKeys,
  },
  llmPurposeOverrides: {
    kind: "typed" as const,
    envKey: "LLM_PURPOSE_OVERRIDES",
    schema: z.record(
      z
        .object({
          provider: z.string().nullable().optional(),
          baseUrl: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
        })
        .nullable(),
    ),
    default: (): LlmPurposeOverrides => ({}),
    parse: parseLlmPurposeOverridesOrNull,
    serialize: serializeLlmPurposeOverrides,
  },
  pipelineWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.PIPELINE_WEBHOOK_URL || process.env.WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobCompleteWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOB_COMPLETE_WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  resumeProjects: {
    kind: "typed" as const,
    schema: resumeProjectsSchema,
    default: (): ResumeProjectsSettings => ({
      maxProjects: 20,
      lockedProjectIds: [],
      aiSelectableProjectIds: [],
    }),
    parse: (raw: string | undefined): ResumeProjectsSettings | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    serialize: (
      value: ResumeProjectsSettings | null | undefined,
    ): string | null => {
      return value ? JSON.stringify(value) : null;
    },
  },
  pdfRenderer: {
    kind: "typed" as const,
    schema: z.enum(PDF_RENDERER_VALUES),
    default: (): PdfRenderer => "rxresume",
    parse: parsePdfRendererOrNull,
    serialize: (value: PdfRenderer | null | undefined): string | null =>
      value ?? null,
  },
  typstTheme: {
    kind: "typed" as const,
    envKey: "TYPST_THEME",
    schema: z.enum(TYPST_THEME_VALUES),
    default: (): TypstTheme => "classic",
    parse: parseTypstThemeOrNull,
    serialize: serializeTypstTheme,
  },
  ukvisajobsMaxJobs: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  adzunaMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.ADZUNA_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  gradcrackerMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  startupjobsMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.STARTUPJOBS_MAX_RESULTS || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  seekMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.SEEK_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  naukriMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.NAUKRI_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  jobindexMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.JOBINDEX_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  searchTerms: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(100),
    default: (): string[] =>
      (typeof process !== "undefined"
        ? process.env.JOBSPY_SEARCH_TERMS || "web developer"
        : "web developer"
      )
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean),
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  workplaceTypes: {
    kind: "typed" as const,
    schema: z.array(z.enum(WORKPLACE_TYPE_VALUES)).min(1).max(3),
    default: (): Array<(typeof WORKPLACE_TYPE_VALUES)[number]> => [
      "remote",
      "hybrid",
      "onsite",
    ],
    parse: parseWorkplaceTypesOrNull,
    serialize: serializeNullableJsonArray,
  },
  blockedCompanyKeywords: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(200),
    default: (): string[] => [],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  scoringInstructions: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  ghostwriterSystemPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string =>
      getDefaultPromptTemplate("ghostwriterSystemPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  ghostwriterStopSlopEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  tailoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("tailoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  scoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("scoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  searchCities: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.SEARCH_CITIES || process.env.JOBSPY_LOCATION || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationSearchScope: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_SEARCH_SCOPE_VALUES),
    default: () => "selected_only" as const,
    parse: parseLocationSearchScopeOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationMatchStrictness: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_MATCH_STRICTNESS_VALUES),
    default: () => "exact_only" as const,
    parse: parseLocationMatchStrictnessOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobspyResultsWanted: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.JOBSPY_RESULTS_WANTED || "200"
          : "200",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  jobspyCountryIndeed: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOBSPY_COUNTRY_INDEED || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  showSponsorInfo: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  renderMarkdownInJobDescriptions: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  chatStyleTone: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_TONE || "professional"
        : "professional",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleFormality: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_FORMALITY || "medium"
        : "medium",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleConstraints: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_CONSTRAINTS || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleDoNotUse: {
    kind: "typed" as const,
    schema: z.string().trim().max(1000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_DO_NOT_USE || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleSummaryMaxWords: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(500).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleMaxKeywordsPerSkill: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(50).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleLanguageMode: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_LANGUAGE_MODE_VALUES),
    default: (): ChatStyleLanguageMode =>
      parseChatStyleLanguageModeOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_LANGUAGE_MODE
          : undefined,
      ) ?? "manual",
    parse: parseChatStyleLanguageModeOrNull,
    serialize: (
      value: ChatStyleLanguageMode | null | undefined,
    ): string | null => value ?? null,
  },
  chatStyleManualLanguage: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_MANUAL_LANGUAGE_VALUES),
    default: (): ChatStyleManualLanguage =>
      parseChatStyleManualLanguageOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_MANUAL_LANGUAGE
          : undefined,
      ) ?? "english",
    parse: parseChatStyleManualLanguageOrNull,
    serialize: (
      value: ChatStyleManualLanguage | null | undefined,
    ): string | null => value ?? null,
  },
  backupEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  backupHour: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(23),
    default: (): number => 2,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(23, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  backupMaxCount: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(5),
    default: (): number => 5,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(5, Math.max(1, parsed));
    },
    serialize: serializeNullableNumber,
  },
  penalizeMissingSalary: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => {
      if (typeof process === "undefined") return false;
      const v = process.env.PENALIZE_MISSING_SALARY || "0";
      return v === "1" || v.toLowerCase() === "true";
    },
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  missingSalaryPenalty: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => {
      if (typeof process === "undefined") return 10;
      const raw = process.env.MISSING_SALARY_PENALTY;
      if (!raw) return 10;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? 10 : Math.min(100, Math.max(0, parsed));
    },
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  autoSkipScoreThreshold: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number | null => null,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: (value: number | null | undefined): string | null => {
      return value === null || value === undefined ? null : String(value);
    },
  },

  // --- Model Variants ---
  modelScorer: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelTailoring: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelProjectSelection: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },

  // --- Simple Strings ---
  rxresumeBaseResumeId: {
    kind: "string" as const,
    schema: z.string().trim().max(200),
  },
  onboardingBasicAuthDecision: {
    kind: "string" as const,
    schema: z.enum(["enabled", "skipped"]),
  },
  rxresumeUrl: {
    kind: "string" as const,
    envKey: "RXRESUME_URL",
    schema: z.preprocess(
      (value) => (value === "" ? null : value),
      z.string().trim().url().max(2000).nullable(),
    ),
  },
  ukvisajobsEmail: {
    kind: "string" as const,
    envKey: "UKVISAJOBS_EMAIL",
    schema: z.string().trim().max(200),
  },
  adzunaAppId: {
    kind: "string" as const,
    envKey: "ADZUNA_APP_ID",
    schema: z.string().trim().max(200),
  },
  basicAuthUser: {
    kind: "string" as const,
    envKey: "BASIC_AUTH_USER",
    schema: z.string().trim().max(200),
  },

  // --- Secrets ---
  llmApiKey: {
    kind: "secret" as const,
    envKey: "LLM_API_KEY",
    schema: z.string().trim().max(2000),
  },
  rxresumeApiKey: {
    kind: "secret" as const,
    envKey: "RXRESUME_API_KEY",
    schema: z.string().trim().max(2000),
  },
  ukvisajobsPassword: {
    kind: "secret" as const,
    envKey: "UKVISAJOBS_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  adzunaAppKey: {
    kind: "secret" as const,
    envKey: "ADZUNA_APP_KEY",
    schema: z.string().trim().max(2000),
  },
  apifyToken: {
    kind: "secret" as const,
    envKey: "APIFY_TOKEN",
    schema: z.string().trim().max(2000),
  },
  basicAuthPassword: {
    kind: "secret" as const,
    envKey: "BASIC_AUTH_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  webhookSecret: {
    kind: "secret" as const,
    envKey: "WEBHOOK_SECRET",
    schema: z.string().trim().max(2000),
  },

  // --- Auto-Application ---
  autoApplicationEnabled: {
    kind: "typed" as const,
    envKey: "AUTO_APP_ENABLED",
    schema: z.boolean(),
    default: (): boolean => false,
    parse: (v: string | undefined): boolean => v === "true",
    serialize: (v: boolean | null | undefined): string | null =>
      v ? "true" : "false",
  },
  autoApplicationDefaultCoverLetter: {
    kind: "typed" as const,
    schema: z.string(),
    default: (): string => "",
    parse: (v: string | undefined): string => v ?? "",
    serialize: (v: string | null | undefined): string | null => v ?? null,
  },
  autoApplicationSalaryRequirement: {
    kind: "typed" as const,
    schema: z.string(),
    default: (): string => "",
    parse: (v: string | undefined): string => v ?? "",
    serialize: (v: string | null | undefined): string | null => v ?? null,
  },
  autoApplicationPdfMaxAgeDays: {
    kind: "typed" as const,
    envKey: "AUTO_APP_PDF_MAX_AGE_DAYS",
    schema: z.number().int().min(1).max(365),
    default: (): number => 7,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },

  // --- Aliases ---
  jobspyLocation: {
    kind: "alias" as const,
    schema: z.string().trim().max(100),
    target: "searchCities" as const,
  },

  resumeParsingMode: {
    kind: "typed" as const,
    schema: z.enum(["llm", "offline"]),
    default: (): "llm" | "offline" => "llm",
    parse: (raw: string | undefined): "llm" | "offline" | null => {
      if (raw === "llm" || raw === "offline") return raw;
      return null;
    },
    serialize: (value: "llm" | "offline" | null | undefined): string | null =>
      value ?? null,
  },

  // --- Virtual ---
  enableBasicAuth: {
    kind: "virtual" as const,
    schema: z.boolean(),
  },
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingsRegistryKey = keyof SettingsRegistry;
