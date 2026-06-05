import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { notFound, unprocessableEntity } from "@infra/errors";
import { logger } from "@infra/logger";
import type { Job, ResumeProfile } from "@shared/types";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { applicationRepository } from "../repositories/applications";
import {
  findAutoApplicableJobs,
  getJobById,
  getJobByUrl,
} from "../repositories/jobs";
import { getActiveTenantId } from "../tenancy/context";
import {
  generateCoverLetterForJob,
  generateScreeningAnswersForJob,
} from "./ghostwriter";
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
  applicationId: string;
  fields: Record<string, string>;
  cover_letter: string;
  screening_answers: Record<string, string>;
  resume_pdf_base64: string;
  resume_filename: string;
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
    const cover_letter = await buildCoverLetter(jobId, profile);
    const screening_answers = await buildScreeningAnswers(
      jobId,
      customQuestions,
    );
    const { resume_pdf_base64, resume_filename } =
      await buildTailoredPdf(jobId);

    const app = applicationRepository.create({
      jobId,
      atsType: atsType as "greenhouse" | "lever",
      status: "preparing",
    });

    applicationRepository.update(app.id, {
      status: "ready_for_review",
      customQuestions: JSON.stringify(customQuestions),
      fieldPayload: JSON.stringify(fields),
      screeningAnswers: JSON.stringify(screening_answers),
    });

    return {
      applicationId: app.id,
      fields,
      cover_letter,
      screening_answers,
      resume_pdf_base64,
      resume_filename,
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
    if (!job) throw notFound("Job not found");

    const existing = applicationRepository.findByJobId(input.jobId);
    const status = input.outcome;

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
  return {
    resume_pdf_base64: bytes.toString("base64"),
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
): Promise<string> {
  const settings = await getEffectiveSettings();
  const profileRecord = profile as unknown as Record<string, unknown>;
  try {
    const letter = await generateCoverLetterForJob({
      jobId,
      profile: profileRecord,
    });
    if (letter && letter.trim().length > 0) {
      return letter;
    }
  } catch (error) {
    logger.warn("buildPayload: Ghostwriter cover letter failed, falling back", {
      jobId,
      error,
    });
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
