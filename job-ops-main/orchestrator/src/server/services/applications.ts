import { notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import type { ResumeProfile } from "@shared/types";
import { applicationRepository } from "../repositories/applications";
import { getJobByUrl } from "../repositories/jobs";
import { getProfile } from "./profile";

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

    const profile = await loadPrepProfile();

    return {
      exists: true,
      job: {
        id: job.id,
        title: job.title,
        employer: job.employer,
        suitabilityScore: job.suitabilityScore ?? 0,
        status: job.status,
      },
      profile,
      hasTailoredPdf: false,
      applicationId: null,
    };
  },

  async buildPayload(
    jobId: string,
    atsType: string,
    customQuestions: string[],
  ): Promise<PayloadResult> {
    const app = applicationRepository.create({
      jobId,
      atsType: atsType as "greenhouse" | "lever",
      status: "preparing",
    });

    applicationRepository.update(app.id, {
      status: "ready_for_review",
      customQuestions: JSON.stringify(customQuestions),
    });

    return {
      applicationId: app.id,
      fields: {},
      cover_letter: "",
      screening_answers: {},
      resume_pdf_base64: "",
      resume_filename: "resume.pdf",
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

async function loadPrepProfile(): Promise<PrepProfile | null> {
  try {
    const profile = await getProfile();
    return mapProfileToPrepProfile(profile);
  } catch (error) {
    logger.warn(
      "Skipping profile in prep response: getProfile failed (onboarding likely incomplete)",
      { error },
    );
    return null;
  }
}

function mapProfileToPrepProfile(profile: ResumeProfile): PrepProfile | null {
  const name = (profile.basics?.name ?? "").trim();
  const email = (profile.basics?.email ?? "").trim();

  if (!name || !email) {
    return null;
  }

  const nameParts = name.split(/\s+/);
  const first_name = nameParts[0] ?? "";
  const last_name = nameParts.slice(1).join(" ");

  return {
    first_name,
    last_name,
    email,
    phone: profile.basics?.phone ?? "",
    linkedin_url: findLinkedInUrl(profile.basics?.profiles),
    current_company: profile.sections?.experience?.items?.[0]?.company ?? "",
  };
}

function findLinkedInUrl(
  profiles: Array<{ network?: string; url?: string }> | undefined,
): string {
  if (!profiles) return "";
  const linkedIn = profiles.find((p) => /linkedin/i.test(p.network ?? ""));
  return linkedIn?.url ?? "";
}
