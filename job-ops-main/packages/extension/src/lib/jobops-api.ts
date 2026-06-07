export interface JobopsResult {
  kind: "jobops:result";
  jobId: string;
  outcome: "submitted" | "skipped" | "failed";
  reason?: string;
  confirmationId?: string;
  fieldSnapshot?: Record<string, string>;
  answersSnapshot?: Record<string, string>;
  screenshotBase64?: string;
}

export interface PrepResponse {
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
  } | null;
  hasTailoredPdf: boolean;
  pdfFreshness?: string;
  applicationId: string | null;
}

export interface PayloadResponse {
  applicationId: string;
  fields: Record<string, string>;
  cover_letter: string;
  screening_answers: Record<string, string>;
  resume_pdf_base64: string;
  resume_filename: string;
}

export interface ConfirmRequest {
  jobId: string;
  applicationId: string;
  atsType: string;
  confirmationId: string;
  submittedAt: string;
  fieldSnapshot: Record<string, string>;
  answersSnapshot: Record<string, string>;
  screenshotBase64: string;
}

export interface ConfirmResponse {
  updated: boolean;
  newStatus: string;
}

export interface QueueItem {
  id: string;
  url: string;
  atsType: string;
  title: string;
  employer: string;
  suitabilityScore: number;
}

export interface QueueResponse {
  jobs: QueueItem[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class JobOpsApi {
  constructor(private baseUrl: string) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const FETCH_TIMEOUT = 5000;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        try {
          const res = await fetch(`${this.baseUrl}${path}`, {
            ...init,
            signal: controller.signal,
            headers: { "Content-Type": "application/json", ...init?.headers },
          });
          const body = await res.json();
          if (!body.ok) {
            throw new ApiError(
              res.status,
              body.error?.code || "UNKNOWN_ERROR",
              body.error?.message || "Request failed",
            );
          }
          return body.data as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        if (
          attempt === 0 &&
          (err instanceof TypeError || err instanceof DOMException)
        ) {
          await this.sleep(1000);
          continue;
        }
        if (err instanceof ApiError) throw err;
        throw new NetworkError(
          "JobOps: Cannot reach server at " +
            this.baseUrl +
            " - is it running?",
        );
      }
    }
    throw new NetworkError("UNREACHABLE");
  }

  isPdfStale(pdfFreshness: string): boolean {
    const pdfDate = new Date(pdfFreshness);
    const now = new Date();
    const diffMs = now.getTime() - pdfDate.getTime();
    return diffMs / (1000 * 60 * 60) > 24;
  }

  prepJob(url: string, ats: string): Promise<PrepResponse> {
    return this.request<PrepResponse>(
      `/api/applications/prep?url=${encodeURIComponent(url)}&ats=${ats}`,
    );
  }

  buildPayload(
    jobId: string,
    atsType: string,
    customQuestions: string[],
  ): Promise<PayloadResponse> {
    return this.request<PayloadResponse>("/api/applications/payload", {
      method: "POST",
      body: JSON.stringify({ jobId, atsType, customQuestions }),
    });
  }

  confirmSubmission(req: ConfirmRequest): Promise<ConfirmResponse> {
    return this.request<ConfirmResponse>("/api/applications/confirm", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  reportQueueResult(msg: JobopsResult): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/applications/queue-result", {
      method: "POST",
      body: JSON.stringify(msg),
    });
  }

  getQueue(limit: number): Promise<QueueResponse> {
    return this.request<QueueResponse>(
      `/api/applications/queue?limit=${limit}`,
    );
  }

  getQueueStatus(): Promise<{
    counts: {
      pending: number;
      submittedToday: number;
      skippedToday: number;
      failedToday: number;
    };
    lastRunAt: string | null;
  }> {
    return this.request("/api/applications/queue/status");
  }
}
