import { readFile } from "node:fs/promises";
import { notFound, unprocessableEntity } from "@infra/errors";
import { logger } from "@infra/logger";
import type { Job, ResumeProfile } from "@shared/types";
import { applicationRepository } from "../repositories/applications";
import { getJobById, getJobByUrl } from "../repositories/jobs";
import {
  generateCoverLetterForJob,
  generateScreeningAnswersForJob,
} from "./ghostwriter";
import { generatePdf, getPdfPath, pdfExists } from "./pdf";
import { getProfile } from "./profile";
import { mapProfileToPrepProfile } from "./profileNormalize";
import { scoreJobSuitability } from "./scorer";
import { getEffectiveSettings } from "./settings";

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
  pdfFreshness?: string;
  applicationId: string | null;
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

export const applicationService = {
  async prepJob(url: string, _atsType: string): Promise<PrepResult> {
    const job = await findJobByUrl(url);
    if (!job) {
      return {
        exists: false,
        hasTailoredPdf: false,
        applicationId: null,
      };
    }

    const fullProfile = await loadProfileOrNull();
    const profile = fullProfile ? mapProfileToPrepProfile(fullProfile) : null;
    const suitabilityScore = await resolveSuitabilityScore(job, fullProfile);
    const { hasTailoredPdf, pdfFreshness } = await resolvePdfFreshness(job);

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
      applicationId: null,
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
};

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
): Promise<number> {
  if (job.suitabilityScore != null) {
    return job.suitabilityScore;
  }
  if (!profile) {
    return 0;
  }
  try {
    const { score } = await scoreJobSuitability(
      job,
      profile as unknown as Record<string, unknown>,
    );
    return score;
  } catch (error) {
    logger.warn("Suitability scoring failed, defaulting to 0", {
      jobId: job.id,
      error,
    });
    return 0;
  }
}

async function resolvePdfFreshness(
  job: Job,
): Promise<{ hasTailoredPdf: boolean; pdfFreshness?: string }> {
  if (!job.pdfGeneratedAt) {
    return { hasTailoredPdf: false };
  }
  try {
    const exists = await pdfExists(job.id);
    if (!exists) {
      return { hasTailoredPdf: false };
    }
    return { hasTailoredPdf: true, pdfFreshness: job.pdfGeneratedAt };
  } catch (error) {
    logger.warn("PDF existence check failed, treating as missing", {
      jobId: job.id,
      error,
    });
    return { hasTailoredPdf: false };
  }
}
