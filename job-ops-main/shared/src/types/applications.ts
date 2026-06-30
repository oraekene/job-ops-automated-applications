export const APPLICATION_STATUSES = [
  "preparing",
  "ready_for_review",
  "approved",
  "submitted",
  "failed",
  "skipped",
  "incomplete",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  id: string;
  tenantId: string;
  jobId: string;
  atsType: "greenhouse" | "lever";
  status: ApplicationStatus;
  fieldPayload: string | null;
  screeningAnswers: string | null;
  customQuestions: string | null;
  confirmationId: string | null;
  submittedAt: string | null;
  screenshotPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateApplicationInput {
  jobId: string;
  atsType: "greenhouse" | "lever";
  status: ApplicationStatus;
}

export interface UpdateApplicationInput {
  status?: ApplicationStatus;
  fieldPayload?: string;
  screeningAnswers?: string;
  customQuestions?: string;
  confirmationId?: string;
  submittedAt?: string;
  screenshotPath?: string;
  errorMessage?: string;
}
