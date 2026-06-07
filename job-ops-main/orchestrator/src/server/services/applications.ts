import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AppError, notFound, unprocessableEntity } from "@infra/errors";
import { logger } from "@infra/logger";
import type { Job, ResumeProfile } from "@shared/types";
import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { applicationRepository } from "../repositories/applications";
import {
  findAutoApplicableJobs,
  getJobById,
  getJobByUrl,
  updateJob,
} from "../repositories/jobs";
import { getActiveTenantId } from "../tenancy/context";
import { generateScreeningAnswersForJob } from "./ghostwriter";
import { generatePdf, getPdfPath, pdfExists } from "./pdf";
import { getProfile } from "./profile";
import { mapProfileToPrepProfile } from "./profileNormalize";
import { getEffectiveSettings } from "./settings";
import { recomputeAndPersistSuitabilityScore } from "./suitability";

/** Suitability scores older than this are considered stale. */
const SUITABILITY_STALENESS_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PrepProfile {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  linkedin_url: string;
  current_company: string;
}

export interface PrepResult {
  exists: boolean;
  job?: {
    id: string;
    title: string;
    employer: string;
    suitabilityScore: number;
    status: string;
  };
  profile?: PrepProfile | null;
  hasTailoredPdf: boolean;
  pdfFreshness?: string | null;
  pdfStale: boolean;
  pdfStaleReason?: "age" | "fingerprint" | "regenerating";
  applicationId: string | null;
  suitabilityStale: boolean;
}

export interface PayloadResult {
  /**
   * US-035: `null` because buildPayload no longer creates the application
   * row. The row is created in `reportQueueResult` when the extension
   * actually reports the outcome.
   */
  applicationId: string | null;
  fields: Record<string, string>;
  cover_letter: string;
  /**
   * US-034: informational stream of the cover letter text emitted as it
   * was generated. Currently always `null` (the consumer can read the
   * final string from `cover_letter`); reserved for future real LLM
   * streaming integration.
   */
  cover_letter_stream: ReadableStream<string> | null;
  screening_answers: Record<string, string>;
  resume_pdf_base64: string;
  resume_filename: string;
  atsType: string;
  customQuestions: string[];
}

export interface ConfirmInput {
  jobId: string;
  applicationId: string;
  atsType: string;
  confirmationId: string;
  submittedAt: string;
  fieldSnapshot?: Record<string, string>;
  answersSnapshot?: Record<string, string>;
  screenshotBase64?: string;
}

export type QueueResultOutcome = "submitted" | "skipped" | "failed";

export interface QueueResultInput {
  jobId: string;
  atsType: "greenhouse" | "lever";
  outcome: QueueResultOutcome;
  reason?: string;
  confirmationId?: string;
  submittedAt?: string;
  fieldSnapshot?: Record<string, string>;
  answersSnapshot?: Record<string, string>;
  screenshotBase64?: string;
}

export const applicationService = {
  async prepJob(url: string, _atsType: string): Promise<PrepResult> {
    const job = await findJobByUrl(url);
    if (!job) {
      return {
        exists: false,
        hasTailoredPdf: false,
        pdfStale: false,
        applicationId: null,
        suitabilityStale: false,
      };
    }

    const fullProfile = await loadProfileOrNull();
    const profile = fullProfile ? mapProfileToPrepProfile(fullProfile) : null;
    const { score: suitabilityScore, stale: suitabilityStale } =
      await resolveSuitabilityScore(job, fullProfile);
    const baseResumeFingerprint =
      await computeBaseResumeFingerprint(fullProfile);
    const settings = await getEffectiveSettings();
    const maxPdfAgeDays = settings.autoApplicationPdfMaxAgeDays.value;
    const { hasTailoredPdf, pdfFreshness, pdfStale, pdfStaleReason } =
      await resolvePdfFreshness(job, baseResumeFingerprint, maxPdfAgeDays);

    return {
      exists: true,
      job: {
        id: job.id,
        title: job.title,
        employer: job.employer,
        suitabilityScore,
        status: job.status,
      },
      profile,
      hasTailoredPdf,
      pdfFreshness,
      pdfStale,
      pdfStaleReason,
      applicationId: null,
      suitabilityStale,
    };
  },

  async buildPayload(
    jobId: string,
    atsType: string,
    customQuestions: string[],
  ): Promise<PayloadResult> {
    const profile = await loadProfileOrThrow(jobId);
    const fields = await buildPayloadFields(profile);
    // US-034: generate screening answers first so the cover letter can be
    // cross-referenced against them (no contradictions on duration claims).
    const screening_answers = await buildScreeningAnswers(
      jobId,
      customQuestions,
    );
    const cover_letter = await buildCoverLetter(jobId, profile, screening_answers);
    const { resume_pdf_base64, resume_filename } =
      await buildTailoredPdf(jobId);

    // US-035: do NOT create the application row here. Row creation is
    // deferred to `reportQueueResult` (called by the extension after it
    // actually fills and submits the form). This avoids ghost rows for
    // crashed extensions and lets us set the final status atomically
    // with the jobs.lastApplicationId / autoApplicable pointer.

    return {
      applicationId: null,
      fields,
      cover_letter,
      cover_letter_stream: null,
      screening_answers,
      resume_pdf_base64,
      resume_filename,
      atsType,
      customQuestions,
    };
  },

  async confirmSubmission(input: ConfirmInput) {
    const app = applicationRepository.findByJobId(input.jobId);
    if (!app) throw notFound("Application not found");

    applicationRepository.update(app.id, {
      status: "submitted",
      confirmationId: input.confirmationId,
      submittedAt: input.submittedAt,
      fieldPayload: input.fieldSnapshot
        ? JSON.stringify(input.fieldSnapshot)
        : null,
      screeningAnswers: input.answersSnapshot
        ? JSON.stringify(input.answersSnapshot)
        : null,
    });

    logger.info("Application confirmed", {
      jobId: input.jobId,
      applicationId: app.id,
      confirmationId: input.confirmationId,
    });

    return { updated: true, newStatus: "applied" as const };
  },

  getPending() {
    return applicationRepository.findPending();
  },

  async reportQueueResult(input: QueueResultInput) {
    const job = await getJobById(input.jobId);
    if (!job) throw notFound(`Job ${input.jobId} not found`);

    const status = input.outcome;

    // US-035: create the application row here (not in buildPayload). Reuse
    // any existing row to keep the call idempotent (e.g. extension retries
    // on a flaky network or reports a later failure after an earlier skip).
    // Legacy `ready_for_review` rows from older builds are also picked up
    // here; `cleanupStalePayloads` marks ones older than 1h as skipped
    // even if the extension never reports back.
    const existing = applicationRepository.findByJobId(input.jobId);
    const app =
      existing ??
      applicationRepository.create({
        jobId: input.jobId,
        atsType: input.atsType,
        status,
      });

    const update: {
      status: typeof status;
      errorMessage: string | null;
      confirmationId?: string | null;
      submittedAt?: string;
      fieldPayload?: string | null;
      screeningAnswers?: string | null;
      screenshotPath?: string | null;
      customQuestions?: string | null;
    } = {
      status,
      errorMessage:
        input.outcome === "submitted" ? null : (input.reason ?? null),
    };

    if (input.outcome === "submitted") {
      update.confirmationId = input.confirmationId ?? null;
      update.submittedAt = input.submittedAt ?? new Date().toISOString();
      if (input.fieldSnapshot) {
        update.fieldPayload = JSON.stringify(input.fieldSnapshot);
      }
      if (input.answersSnapshot) {
        update.screeningAnswers = JSON.stringify(input.answersSnapshot);
      }
    }

    if (input.screenshotBase64) {
      update.screenshotPath = await saveScreenshot(
        app.id,
        input.screenshotBase64,
      );
    }

    applicationRepository.update(app.id, update);

    // US-035: point the job at the new application and remove it from
    // the auto-apply pool so the next queue poll does not re-dispatch it.
    try {
      await updateJob(input.jobId, {
        lastApplicationId: app.id,
        autoApplicable: false,
      });
    } catch (error) {
      logger.warn("reportQueueResult: failed to update job pointer", {
        jobId: input.jobId,
        applicationId: app.id,
        error,
      });
    }

    logger.info("Queue result reported", {
      jobId: input.jobId,
      applicationId: app.id,
      outcome: input.outcome,
      reason: input.reason,
    });

    return { applicationId: app.id, newStatus: status };
  },

  async getAutoApplicableQueue(limit: number = QUEUE_DEFAULT_LIMIT): Promise<{
    jobs: Array<{
      id: string;
      url: string;
      atsType: string;
      title: string;
      employer: string;
      suitabilityScore: number;
    }>;
  }> {
    const settings = await getEffectiveSettings();
    if (!settings.autoApplicationEnabled.value) {
      return { jobs: [] };
    }

    const clampedLimit = clampQueueLimit(limit);
    const jobs = await findAutoApplicableJobs(clampedLimit);
    return { jobs };
  },

  async getQueueStatus(): Promise<{
    counts: {
      pending: number;
      submittedToday: number;
      skippedToday: number;
      failedToday: number;
    };
    lastRunAt: string | null;
  }> {
    const tenantId = getActiveTenantId();
    const todayStart = startOfTodayUtcIso();

    // 1. JobIds that have a terminal "completed" application row from today.
    //    Submissions older than today are treated as "stale" and the job
    //    is re-queued as pending.
    const completedJobIds = db
      .select({ jobId: schema.applications.jobId })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.tenantId, tenantId),
          inArray(schema.applications.status, ["submitted", "skipped"]),
          sql`${schema.applications.updatedAt} >= ${todayStart}`,
        ),
      )
      .all()
      .map((r) => r.jobId);

    // 2. Pending = auto-applicable jobs not in the completed set.
    const pendingWhere = and(
      eq(schema.jobs.tenantId, tenantId),
      eq(schema.jobs.autoApplicable, true),
    );
    const pendingResult =
      completedJobIds.length > 0
        ? db
            .select({ count: sql<number>`COUNT(*)` })
            .from(schema.jobs)
            .where(
              and(pendingWhere, notInArray(schema.jobs.id, completedJobIds)),
            )
            .get()
        : db
            .select({ count: sql<number>`COUNT(*)` })
            .from(schema.jobs)
            .where(pendingWhere)
            .get();

    // 3. Today counts grouped by status.
    const todayRows = db
      .select({
        status: schema.applications.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.tenantId, tenantId),
          sql`${schema.applications.updatedAt} >= ${todayStart}`,
        ),
      )
      .groupBy(schema.applications.status)
      .all();
    const todayMap = new Map(todayRows.map((r) => [r.status, r.count]));

    // 4. Most recent application activity for the tenant.
    const lastRunRow = db
      .select({
        max: sql<string | null>`MAX(${schema.applications.updatedAt})`,
      })
      .from(schema.applications)
      .where(eq(schema.applications.tenantId, tenantId))
      .get();

    return {
      counts: {
        pending: pendingResult?.count ?? 0,
        submittedToday: todayMap.get("submitted") ?? 0,
        skippedToday: todayMap.get("skipped") ?? 0,
        failedToday: todayMap.get("failed") ?? 0,
      },
      lastRunAt: lastRunRow?.max ?? null,
    };
  },
};

export const QUEUE_DEFAULT_LIMIT = 10;
export const QUEUE_MAX_LIMIT = 50;

export function clampQueueLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return QUEUE_DEFAULT_LIMIT;
  return Math.min(QUEUE_MAX_LIMIT, Math.floor(limit));
}

/**
 * Normalize a job URL for comparison. Strips the URL fragment, query string,
 * and trailing slash so that variant forms of the same canonical URL
 * (e.g. `?gh_jid=12345` query params on a Greenhouse URL) match the stored row.
 */
function normalizeJobUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    const normalized = parsed.toString();
    return normalized.endsWith("/") && parsed.pathname !== "/"
      ? normalized.slice(0, -1)
      : normalized;
  } catch {
    return raw;
  }
}

async function findJobByUrl(url: string) {
  const direct = await getJobByUrl(url);
  if (direct) return direct;

  const normalized = normalizeJobUrl(url);
  if (normalized === url) return null;

  return getJobByUrl(normalized);
}

async function loadProfileOrNull(): Promise<ResumeProfile | null> {
  try {
    return await getProfile();
  } catch (error) {
    logger.warn(
      "Skipping profile in prep response: getProfile failed (onboarding likely incomplete)",
      { error },
    );
    return null;
  }
}

async function buildScreeningAnswers(
  jobId: string,
  customQuestions: string[],
): Promise<Record<string, string>> {
  if (customQuestions.length === 0) {
    return {};
  }
  const { ScreeningAnswersUnavailableError, ScreeningAnswersValidationError } =
    await import("./ghostwriter");
  try {
    const profile = await getProfile();
    const profileRecord =
      profile && typeof profile === "object" && !Array.isArray(profile)
        ? (profile as unknown as Record<string, unknown>)
        : {};
    return await generateScreeningAnswersForJob({
      jobId,
      profile: profileRecord,
      questions: customQuestions,
    });
  } catch (error) {
    if (
      error instanceof ScreeningAnswersUnavailableError ||
      error instanceof ScreeningAnswersValidationError
    ) {
      throw unprocessableEntity(
        `Screening answers unavailable for ${customQuestions.length} question(s): ${error.message}`,
      );
    }
    logger.warn("buildPayload: screening answer generation failed", {
      jobId,
      error,
    });
    return Object.fromEntries(customQuestions.map((q) => [q, ""]));
  }
}

async function buildTailoredPdf(
  jobId: string,
): Promise<{ resume_pdf_base64: string; resume_filename: string }> {
  const job = await getJobById(jobId);
  if (!job) {
    throw unprocessableEntity(`Job ${jobId} not found for PDF generation`);
  }

  const result = await generatePdf(jobId, {}, job.jobDescription ?? "");
  if (!result.success) {
    throw unprocessableEntity(
      `PDF generation failed: ${result.error ?? "unknown error"}`,
    );
  }

  const pdfPath = getPdfPath(jobId);
  const bytes = await readFile(pdfPath);

  // Integrity check: first 5 bytes must be %PDF-
  const magic = bytes.subarray(0, 5).toString("ascii");
  if (magic !== "%PDF-") {
    throw unprocessableEntity("PDF integrity check failed: invalid header");
  }

  // Size check: reject files larger than 10 MB
  const fileStats = await stat(pdfPath);
  const MAX_PDF_BYTES = 10 * 1024 * 1024;
  if (fileStats.size > MAX_PDF_BYTES) {
    throw new AppError({
      status: 413,
      code: "UNPROCESSABLE_ENTITY",
      message: "PDF exceeds 10MB limit",
    });
  }

  // Compress with gzip before base64-encoding
  const compressed = gzipSync(bytes, { level: 6 });

  return {
    resume_pdf_base64: `data:application/pdf;base64,${compressed.toString("base64")}`,
    resume_filename: `resume_${jobId}.pdf`,
  };
}

async function loadProfileOrThrow(jobId: string): Promise<ResumeProfile> {
  let profile: ResumeProfile | null = null;
  try {
    profile = await getProfile();
  } catch (error) {
    logger.warn("buildPayload: getProfile failed, throwing 404", {
      jobId,
      error,
    });
  }
  if (!profile) {
    throw notFound("Profile not loaded. Complete onboarding first.");
  }
  return profile;
}

async function buildPayloadFields(
  profile: ResumeProfile,
): Promise<Record<string, string>> {
  const settings = await getEffectiveSettings();
  const prep = mapProfileToPrepProfile(profile);
  if (!prep) {
    throw notFound("Profile is missing required fields (name, email).");
  }
  return {
    first_name: prep.first_name,
    last_name: prep.last_name,
    email: prep.email,
    phone: prep.phone,
    linkedin_url: prep.linkedin_url,
    current_company: prep.current_company,
    salary: settings.autoApplicationSalaryRequirement?.value ?? "",
  };
}

async function buildCoverLetter(
  jobId: string,
  profile: ResumeProfile,
  screeningAnswers: Record<string, string>,
): Promise<string> {
  const settings = await getEffectiveSettings();
  const profileRecord = profile as unknown as Record<string, unknown>;
  const { CoverLetterValidationError, generateCoverLetterForJob } =
    await import("./ghostwriter");
  try {
    const letter = await generateCoverLetterForJob({
      jobId,
      profile: profileRecord,
      screeningAnswers,
    });
    if (letter && letter.trim().length > 0) {
      return letter;
    }
  } catch (error) {
    if (error instanceof CoverLetterValidationError) {
      logger.warn(
        "buildPayload: cover letter failed validation, falling back to default",
        {
          jobId,
          reason: error.reason,
          message: error.message,
        },
      );
    } else {
      logger.warn(
        "buildPayload: Ghostwriter cover letter failed, falling back",
        {
          jobId,
          error,
        },
      );
    }
  }
  return settings.autoApplicationDefaultCoverLetter?.value ?? "";
}

async function resolveSuitabilityScore(
  job: Job,
  profile: ResumeProfile | null,
): Promise<{ score: number; stale: boolean }> {
  // No stored score → compute once (no staleness possible, nothing to compare).
  if (job.suitabilityScore == null) {
    if (!profile) return { score: 0, stale: false };
    try {
      const { score } = await recomputeAndPersistSuitabilityScore(
        job,
        profile as unknown as Record<string, unknown>,
      );
      return { score, stale: false };
    } catch (error) {
      logger.warn("Suitability scoring failed, defaulting to 0", {
        jobId: job.id,
        error,
      });
      return { score: 0, stale: false };
    }
  }

  // Stored score present. Decide whether it's stale.
  const isStale =
    job.suitabilityComputedAt != null &&
    isOlderThanDays(job.suitabilityComputedAt, SUITABILITY_STALENESS_DAYS);

  if (isStale && profile) {
    try {
      const { score } = await recomputeAndPersistSuitabilityScore(
        job,
        profile as unknown as Record<string, unknown>,
      );
      return { score, stale: true };
    } catch (error) {
      logger.warn("Suitability recompute failed, returning stored score", {
        jobId: job.id,
        error,
      });
      return { score: job.suitabilityScore, stale: true };
    }
  }

  // Stored score is fresh, or we have no profile to recompute against.
  return { score: job.suitabilityScore, stale: false };
}

function isOlderThanDays(iso: string, days: number): boolean {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > days * MS_PER_DAY;
}

/** ISO 8601 string for the start of today (UTC, e.g. 2026-06-04T00:00:00.000Z). */
function startOfTodayUtcIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

async function resolvePdfFreshness(
  job: Job,
  baseResumeFingerprint: string | null,
  maxPdfAgeDays: number,
): Promise<{
  hasTailoredPdf: boolean;
  pdfFreshness: string | null;
  pdfStale: boolean;
  pdfStaleReason?: "age" | "fingerprint" | "regenerating";
}> {
  if (job.pdfRegenerating) {
    return {
      hasTailoredPdf: false,
      pdfFreshness: null,
      pdfStale: false,
      pdfStaleReason: "regenerating",
    };
  }
  if (!job.pdfGeneratedAt) {
    return { hasTailoredPdf: false, pdfFreshness: null, pdfStale: false };
  }
  try {
    const exists = await pdfExists(job.id);
    if (!exists) {
      return { hasTailoredPdf: false, pdfFreshness: null, pdfStale: false };
    }
    const ageMs = Date.now() - new Date(job.pdfGeneratedAt).getTime();
    const ageStale = ageMs > maxPdfAgeDays * MS_PER_DAY;
    const fingerprintStale =
      baseResumeFingerprint !== null &&
      job.pdfFingerprint !== null &&
      job.pdfFingerprint !== baseResumeFingerprint;
    if (ageStale) {
      return {
        hasTailoredPdf: true,
        pdfFreshness: job.pdfGeneratedAt,
        pdfStale: true,
        pdfStaleReason: "age",
      };
    }
    if (fingerprintStale) {
      return {
        hasTailoredPdf: true,
        pdfFreshness: job.pdfGeneratedAt,
        pdfStale: true,
        pdfStaleReason: "fingerprint",
      };
    }
    return {
      hasTailoredPdf: true,
      pdfFreshness: job.pdfGeneratedAt,
      pdfStale: false,
    };
  } catch (error) {
    logger.warn("PDF existence check failed, treating as missing", {
      jobId: job.id,
      error,
    });
    return { hasTailoredPdf: false, pdfFreshness: null, pdfStale: false };
  }
}

/**
 * Compute a short, stable fingerprint of the base resume content.
 * Returns null if no profile is available, in which case the caller should
 * fall back to age-based staleness only.
 */
async function computeBaseResumeFingerprint(
  profile: ResumeProfile | null,
): Promise<string | null> {
  if (!profile) return null;
  try {
    const json = JSON.stringify(profile);
    return createHash("sha256").update(json).digest("hex").slice(0, 16);
  } catch (error) {
    logger.warn(
      "Could not compute base resume fingerprint; age-based staleness only",
      { error },
    );
    return null;
  }
}

/**
 * Decode a base64 screenshot from the extension and write it to
 * <dataDir>/screenshots/<applicationId>.png. Returns the absolute path.
 */
async function saveScreenshot(
  applicationId: string,
  base64: string,
): Promise<string> {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  const dir = join(dataDir, "screenshots");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${applicationId}.png`);
  const buffer = Buffer.from(base64, "base64");
  await writeFile(filePath, buffer);
  return filePath;
}

/**
 * US-035: how old a `ready_for_review` application row must be (in
 * milliseconds) before `cleanupStalePayloads` marks it as skipped.
 * Defensive: under the US-035 model, buildPayload no longer creates
 * rows, so this cleanup is for rows created by older builds and for
 * rows created by other code paths.
 */
export const STALE_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * US-035: Mark any application row with `status = 'ready_for_review'`
 * and `updatedAt < now - STALE_PAYLOAD_MAX_AGE_MS` as
 * `status: 'skipped', errorMessage: 'stale payload'`. Returns the
 * number of rows that were marked.
 *
 * Safe to call repeatedly; idempotent. Safe to call on an empty DB.
 */
export function cleanupStalePayloads(): number {
  const cutoff = new Date(Date.now() - STALE_PAYLOAD_MAX_AGE_MS).toISOString();
  const tenantId = getActiveTenantId();
  const updated = db
    .update(schema.applications)
    .set({
      status: "skipped",
      errorMessage: "stale payload",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.applications.tenantId, tenantId),
        eq(schema.applications.status, "ready_for_review"),
        lt(schema.applications.updatedAt, cutoff),
      ),
    )
    .run();
  return updated.changes;
}
