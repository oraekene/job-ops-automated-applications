import { notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { applicationRepository } from "../repositories/applications";

export interface PrepResult {
  exists: boolean;
  job?: {
    id: string;
    title: string;
    employer: string;
    suitabilityScore: number;
    status: string;
  };
  profile?: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    linkedin_url: string;
    current_company: string;
  };
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
  async prepJob(_url: string, _atsType: string): Promise<PrepResult> {
    return {
      exists: false,
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
