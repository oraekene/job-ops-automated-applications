import {
  badRequest,
  conflict,
  notFound,
  requestTimeout,
  upstreamError,
} from "@infra/errors";
import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import {
  GHOSTWRITER_DOCUMENT_CONTEXT_MAX_SELECTED,
  normalizeGhostwriterSelectedDocumentIds,
} from "@shared/ghostwriter-document-context.js";
import {
  GHOSTWRITER_EMAIL_CONTEXT_MAX_SELECTED,
  normalizeGhostwriterSelectedEmailIds,
} from "@shared/ghostwriter-email-context.js";
import {
  GHOSTWRITER_NOTE_CONTEXT_MAX_SELECTED,
  normalizeGhostwriterSelectedNoteIds,
} from "@shared/ghostwriter-note-context.js";
import type {
  BranchInfo,
  JobChatImageAttachment,
  JobChatMessage,
  JobChatRun,
} from "@shared/types";
import * as jobChatRepo from "../repositories/ghostwriter";
import * as jobDocumentsRepo from "../repositories/job-documents";
import * as jobsRepo from "../repositories/jobs";
import {
  buildJobChatPromptContext,
  canUseJobDocumentForGhostwriterContext,
} from "./ghostwriter-context";
import { LlmService } from "./llm/service";
import type { JsonSchemaDefinition } from "./llm/types";
import { resolveLlmRuntimeSettings as resolveRuntimeLlmSettings } from "./modelSelection";
import { listJobPostApplicationEmailsByIds } from "./post-application/job-emails";

type LlmRuntimeSettings = {
  model: string;
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
};

const abortControllers = new Map<string, AbortController>();
const OPENROUTER_CAPABILITY_TIMEOUT_MS = 2500;
const OPENROUTER_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const openRouterImageCapabilityCache = new Map<
  string,
  { reason: string | null | undefined; expiresAt: number }
>();

const CHAT_RESPONSE_SCHEMA: JsonSchemaDefinition = {
  name: "job_chat_response",
  schema: {
    type: "object",
    properties: {
      response: {
        type: "string",
      },
    },
    required: ["response"],
    additionalProperties: false,
  },
};

function estimateTokenCount(value: string): number {
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

function chunkText(value: string, maxChunk = 60): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    chunks.push(value.slice(cursor, cursor + maxChunk));
    cursor += maxChunk;
  }
  return chunks;
}

function isRunningRunUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("idx_job_chat_runs_thread_running_unique") ||
    message.includes("UNIQUE constraint failed: job_chat_runs.thread_id")
  );
}

async function resolveLlmRuntimeSettings(): Promise<LlmRuntimeSettings> {
  return resolveRuntimeLlmSettings("tailoring");
}

async function buildConversationMessages(
  threadId: string,
  targetMessageId?: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  // If a target message is given, walk its ancestor path (branch-aware).
  // Otherwise, fall back to the active path from root.
  const messages = targetMessageId
    ? await jobChatRepo.getAncestorPath(targetMessageId)
    : await jobChatRepo.getActivePathFromRoot(threadId);

  return messages
    .filter(
      (message): message is typeof message & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .filter((message) => message.status !== "failed")
    .slice(-40)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

type GenerateReplyOptions = {
  jobId: string;
  threadId: string;
  prompt: string;
  attachments?: readonly JobChatImageAttachment[];
  llmConfig?: LlmRuntimeSettings;
  replaceMessageId?: string;
  version?: number;
  /** Parent message ID for the assistant reply (i.e. the user message that triggered it). */
  parentMessageId?: string;
  stream?: {
    onReady: (payload: {
      runId: string;
      threadId: string;
      messageId: string;
      requestId: string;
    }) => void;
    onDelta: (payload: {
      runId: string;
      messageId: string;
      delta: string;
    }) => void;
    onCompleted: (payload: {
      runId: string;
      message: Awaited<ReturnType<typeof jobChatRepo.getMessageById>>;
    }) => void;
    onCancelled: (payload: {
      runId: string;
      message: Awaited<ReturnType<typeof jobChatRepo.getMessageById>>;
    }) => void;
    onError: (payload: {
      runId: string;
      code: string;
      message: string;
      requestId: string;
    }) => void;
  };
};

function resolveOpenRouterModelsUrl(baseUrl: string | null): string {
  const normalized = (baseUrl || "https://openrouter.ai").replace(/\/+$/, "");
  if (normalized.endsWith("/api/v1")) return `${normalized}/models`;
  return `${normalized}/api/v1/models`;
}

function buildOpenRouterCapabilityCacheKey(input: LlmRuntimeSettings): string {
  return [
    "openrouter",
    input.baseUrl || "https://openrouter.ai",
    input.model.trim().toLowerCase(),
  ].join(":");
}

async function getOpenRouterImageCapabilityReason(
  input: LlmRuntimeSettings,
): Promise<string | null | undefined> {
  const cacheKey = buildOpenRouterCapabilityCacheKey(input);
  const cached = openRouterImageCapabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.reason;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENROUTER_CAPABILITY_TIMEOUT_MS,
  );

  try {
    const headers: Record<string, string> = {};
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const response = await fetch(resolveOpenRouterModelsUrl(input.baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        architecture?: { input_modalities?: unknown };
      }>;
    };
    const model = input.model.trim().toLowerCase();
    const match = payload.data?.find((candidate) => {
      const id = typeof candidate.id === "string" ? candidate.id : "";
      return id.toLowerCase() === model;
    });
    if (!match) {
      openRouterImageCapabilityCache.set(cacheKey, {
        reason: undefined,
        expiresAt: Date.now() + OPENROUTER_CAPABILITY_CACHE_TTL_MS,
      });
      return undefined;
    }

    const modalities = match.architecture?.input_modalities;
    if (!Array.isArray(modalities)) return undefined;
    const reason = modalities.some(
      (modality) => typeof modality === "string" && modality === "image",
    )
      ? null
      : `The selected OpenRouter model (${input.model}) does not accept image input.`;
    openRouterImageCapabilityCache.set(cacheKey, {
      reason,
      expiresAt: Date.now() + OPENROUTER_CAPABILITY_CACHE_TTL_MS,
    });
    return reason;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function imageInputCapabilityReason(
  input: LlmRuntimeSettings,
): Promise<string | null> {
  const provider = (input.provider || "openrouter").toLowerCase();
  const model = input.model.trim().toLowerCase();
  if (!model) return "No AI model is configured.";

  const blockedModelPatterns = [
    "embedding",
    "audio",
    "moderation",
    "tts",
    "whisper",
    "dall-e",
    "image-generation",
    "codex",
  ];
  if (blockedModelPatterns.some((pattern) => model.includes(pattern))) {
    return `The selected model (${input.model}) does not accept image input.`;
  }

  if (provider === "openai") {
    const supported = [
      /^gpt-4o\b/,
      /^gpt-4\.1\b/,
      /^gpt-4\.5\b/,
      /^gpt-5\b/,
      /^chatgpt-4o\b/,
      /^o3\b/,
      /^o4\b/,
    ].some((pattern) => pattern.test(model));
    return supported
      ? null
      : `The selected OpenAI model (${input.model}) is not recognized as image-capable.`;
  }

  if (provider === "gemini" || provider === "gemini_cli") {
    return /^google\/gemini|^gemini|^models\/gemini/.test(model)
      ? null
      : `The selected Gemini model (${input.model}) is not recognized as image-capable.`;
  }

  if (provider === "openrouter" || provider === "openai_compatible") {
    if (provider === "openrouter") {
      const metadataReason = await getOpenRouterImageCapabilityReason(input);
      if (metadataReason !== undefined) return metadataReason;
    }

    const supportedSignals = [
      "vision",
      "-vl",
      "/vl",
      "qwen2-vl",
      "qwen2.5-vl",
      "llava",
      "pixtral",
      "gemini",
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.5",
      "gpt-5",
      "claude-3",
      "claude-sonnet-4",
      "claude-opus-4",
      "mistral-medium-3",
    ];
    return supportedSignals.some((signal) => model.includes(signal))
      ? null
      : `The selected model (${input.model}) is not recognized as image-capable.`;
  }

  return `Screenshot context is not available for the current AI provider (${input.provider || "openrouter"}).`;
}

function buildUserPromptContent(
  prompt: string,
  attachments: readonly JobChatImageAttachment[] | undefined,
) {
  if (!attachments?.length) return prompt;
  return [
    {
      type: "text" as const,
      text: [
        prompt,
        "",
        `The user attached ${attachments.length} screenshot${attachments.length === 1 ? "" : "s"} for visual context. Inspect the image content directly and use it only where relevant.`,
      ].join("\n"),
    },
    ...attachments.map((attachment) => ({
      type: "image" as const,
      imageUrl: attachment.dataUrl,
      mediaType: attachment.mediaType,
      name: attachment.name,
    })),
  ];
}

async function resolveAndValidateImageInput(
  attachments: readonly JobChatImageAttachment[] | undefined,
): Promise<LlmRuntimeSettings | undefined> {
  if (!attachments?.length) return undefined;

  const llmConfig = await resolveLlmRuntimeSettings();
  const capabilityReason = await imageInputCapabilityReason(llmConfig);
  if (capabilityReason) {
    throw badRequest(capabilityReason, {
      provider: llmConfig.provider || "openrouter",
      model: llmConfig.model,
    });
  }
  return llmConfig;
}

async function ensureJobThread(jobId: string) {
  return jobChatRepo.getOrCreateThreadForJob({
    jobId,
    title: null,
  });
}

async function validateSelectedContextIdsForJob<TItem>(input: {
  selectedIds: readonly string[];
  maxSelected: number;
  contextLabel: string;
  maxSelectedDetailsKey: string;
  invalidIdsDetailsKey: string;
  normalize: (selectedIds: readonly string[]) => string[];
  listItems: (normalizedIds: string[]) => Promise<TItem[]>;
  getId: (item: TItem) => string;
}): Promise<string[]> {
  const normalizedIds = input.normalize(input.selectedIds);

  if (normalizedIds.length > input.maxSelected) {
    throw badRequest(
      `Select up to ${input.maxSelected} ${input.contextLabel}s for Ghostwriter context`,
      {
        [input.maxSelectedDetailsKey]: input.maxSelected,
        selectedCount: normalizedIds.length,
      },
    );
  }

  if (normalizedIds.length === 0) return [];

  const items = await input.listItems(normalizedIds);
  const itemIdsForJob = new Set(items.map(input.getId));
  const invalidIds = normalizedIds.filter(
    (selectedId) => !itemIdsForJob.has(selectedId),
  );

  if (invalidIds.length > 0) {
    throw badRequest(
      `Selected ${input.contextLabel}s must belong to this job`,
      {
        [input.invalidIdsDetailsKey]: invalidIds,
      },
    );
  }

  return normalizedIds;
}

async function validateSelectedNoteIdsForJob(
  jobId: string,
  selectedNoteIds: readonly string[],
): Promise<string[]> {
  return validateSelectedContextIdsForJob({
    selectedIds: selectedNoteIds,
    maxSelected: GHOSTWRITER_NOTE_CONTEXT_MAX_SELECTED,
    contextLabel: "note",
    maxSelectedDetailsKey: "maxSelectedNotes",
    invalidIdsDetailsKey: "invalidNoteIds",
    normalize: normalizeGhostwriterSelectedNoteIds,
    listItems: (normalizedNoteIds) =>
      jobsRepo.listJobNotesByIds(jobId, normalizedNoteIds),
    getId: (note) => note.id,
  });
}

async function validateSelectedEmailIdsForJob(
  jobId: string,
  selectedEmailIds: readonly string[],
): Promise<string[]> {
  return validateSelectedContextIdsForJob({
    selectedIds: selectedEmailIds,
    maxSelected: GHOSTWRITER_EMAIL_CONTEXT_MAX_SELECTED,
    contextLabel: "email",
    maxSelectedDetailsKey: "maxSelectedEmails",
    invalidIdsDetailsKey: "invalidEmailIds",
    normalize: normalizeGhostwriterSelectedEmailIds,
    listItems: (normalizedEmailIds) =>
      listJobPostApplicationEmailsByIds(jobId, normalizedEmailIds),
    getId: (email) => email.message.id,
  });
}

async function validateSelectedDocumentIdsForJob(
  jobId: string,
  selectedDocumentIds: readonly string[],
): Promise<string[]> {
  const normalizedIds =
    normalizeGhostwriterSelectedDocumentIds(selectedDocumentIds);

  if (normalizedIds.length > GHOSTWRITER_DOCUMENT_CONTEXT_MAX_SELECTED) {
    throw badRequest(
      `Select up to ${GHOSTWRITER_DOCUMENT_CONTEXT_MAX_SELECTED} documents for Ghostwriter context`,
      {
        maxSelectedDocuments: GHOSTWRITER_DOCUMENT_CONTEXT_MAX_SELECTED,
        selectedCount: normalizedIds.length,
      },
    );
  }

  if (normalizedIds.length === 0) return [];

  const documents = await jobDocumentsRepo.listJobDocumentsByIds(
    jobId,
    normalizedIds,
  );
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const invalidDocumentIds = normalizedIds.filter(
    (documentId) => !documentsById.has(documentId),
  );
  if (invalidDocumentIds.length > 0) {
    throw badRequest("Selected documents must belong to this job", {
      invalidDocumentIds,
    });
  }

  const unsupportedDocumentIds = normalizedIds.filter((documentId) => {
    const document = documentsById.get(documentId);
    return document ? !canUseJobDocumentForGhostwriterContext(document) : false;
  });
  if (unsupportedDocumentIds.length > 0) {
    throw badRequest(
      "Selected documents must be PDFs or text-like files for Ghostwriter context",
      { unsupportedDocumentIds },
    );
  }

  return normalizedIds;
}

async function updateThreadContext(input: {
  jobId: string;
  threadId: string;
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
}) {
  const [selectedNoteIds, selectedEmailIds, selectedDocumentIds] =
    await Promise.all([
      input.selectedNoteIds === undefined
        ? Promise.resolve(undefined)
        : validateSelectedNoteIdsForJob(input.jobId, input.selectedNoteIds),
      input.selectedEmailIds === undefined
        ? Promise.resolve(undefined)
        : validateSelectedEmailIdsForJob(input.jobId, input.selectedEmailIds),
      input.selectedDocumentIds === undefined
        ? Promise.resolve(undefined)
        : validateSelectedDocumentIdsForJob(
            input.jobId,
            input.selectedDocumentIds,
          ),
    ]);
  const thread = await jobChatRepo.updateThreadContext({
    jobId: input.jobId,
    threadId: input.threadId,
    selectedNoteIds,
    selectedEmailIds,
    selectedDocumentIds,
  });

  if (!thread) {
    throw notFound("Thread not found for this job");
  }

  return thread;
}

export async function createThread(input: {
  jobId: string;
  title?: string | null;
}) {
  return ensureJobThread(input.jobId);
}

export async function listThreads(jobId: string) {
  const thread = await ensureJobThread(jobId);
  return [thread];
}

export async function updateContextForJob(input: {
  jobId: string;
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
}) {
  const thread = await ensureJobThread(input.jobId);
  const updatedThread = await updateThreadContext({
    jobId: input.jobId,
    threadId: thread.id,
    selectedNoteIds: input.selectedNoteIds,
    selectedEmailIds: input.selectedEmailIds,
    selectedDocumentIds: input.selectedDocumentIds,
  });

  return {
    selectedNoteIds: updatedThread.selectedNoteIds,
    selectedEmailIds: updatedThread.selectedEmailIds,
    selectedDocumentIds: updatedThread.selectedDocumentIds,
  };
}

async function buildBranchInfoForPath(
  messages: JobChatMessage[],
): Promise<BranchInfo[]> {
  const branches: BranchInfo[] = [];

  for (const msg of messages) {
    const { siblings, activeIndex } = await jobChatRepo.getSiblingsOf(msg.id);
    if (siblings.length > 1) {
      branches.push({
        messageId: msg.id,
        siblingIds: siblings.map((s) => s.id),
        activeIndex,
      });
    }
  }

  return branches;
}

export async function listMessages(input: {
  jobId: string;
  threadId: string;
  limit?: number;
  offset?: number;
}): Promise<{ messages: JobChatMessage[]; branches: BranchInfo[] }> {
  const thread = await jobChatRepo.getThreadForJob(input.jobId, input.threadId);
  if (!thread) {
    throw notFound("Thread not found for this job");
  }

  const messages = await jobChatRepo.getActivePathFromRoot(input.threadId);
  const branches = await buildBranchInfoForPath(messages);
  return { messages, branches };
}

export async function listMessagesForJob(input: {
  jobId: string;
  limit?: number;
  offset?: number;
}): Promise<{
  messages: JobChatMessage[];
  branches: BranchInfo[];
  selectedNoteIds: string[];
  selectedEmailIds: string[];
  selectedDocumentIds: string[];
}> {
  const thread = await ensureJobThread(input.jobId);
  const messages = await jobChatRepo.getActivePathFromRoot(thread.id);
  const branches = await buildBranchInfoForPath(messages);
  return {
    messages,
    branches,
    selectedNoteIds: thread.selectedNoteIds,
    selectedEmailIds: thread.selectedEmailIds,
    selectedDocumentIds: thread.selectedDocumentIds,
  };
}

async function runAssistantReply(
  options: GenerateReplyOptions,
): Promise<{ runId: string; messageId: string; message: string }> {
  const thread = await jobChatRepo.getThreadForJob(
    options.jobId,
    options.threadId,
  );
  if (!thread) {
    throw notFound("Thread not found for this job");
  }

  const activeRun = await jobChatRepo.getActiveRunForThread(options.threadId);
  if (activeRun) {
    throw conflict("A chat generation is already running for this thread");
  }

  const [context, resolvedLlmConfig, history] = await Promise.all([
    buildJobChatPromptContext(
      options.jobId,
      thread.selectedNoteIds,
      thread.selectedEmailIds,
      thread.selectedDocumentIds,
    ),
    options.llmConfig ?? resolveLlmRuntimeSettings(),
    buildConversationMessages(options.threadId, options.parentMessageId),
  ]);
  const llmConfig = resolvedLlmConfig;

  const requestId = getRequestId() ?? "unknown";

  let run: JobChatRun;
  try {
    run = await jobChatRepo.createRun({
      threadId: options.threadId,
      jobId: options.jobId,
      model: llmConfig.model,
      provider: llmConfig.provider,
      requestId,
    });
  } catch (error) {
    if (isRunningRunUniqueConstraintError(error)) {
      throw conflict("A chat generation is already running for this thread");
    }
    throw error;
  }

  let assistantMessage: JobChatMessage;
  try {
    assistantMessage = await jobChatRepo.createMessage({
      threadId: options.threadId,
      jobId: options.jobId,
      role: "assistant",
      content: "",
      status: "partial",
      version: options.version ?? 1,
      replacesMessageId: options.replaceMessageId ?? null,
      parentMessageId: options.parentMessageId ?? null,
    });
  } catch (error) {
    await jobChatRepo.completeRun(run.id, {
      status: "failed",
      errorCode: "INTERNAL_ERROR",
      errorMessage: "Failed to create assistant message",
    });
    throw error;
  }

  const controller = new AbortController();
  abortControllers.set(run.id, controller);
  options.stream?.onReady({
    runId: run.id,
    threadId: options.threadId,
    messageId: assistantMessage.id,
    requestId,
  });

  let accumulated = "";

  try {
    const llm = new LlmService({
      provider: llmConfig.provider,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
    });

    const llmResult = await llm.callJson<{ response: string }>({
      model: llmConfig.model,
      messages: [
        {
          role: "system",
          content: context.systemPrompt,
        },
        {
          role: "system",
          content: `Job Context (JSON):\n${context.jobSnapshot}`,
        },
        {
          role: "system",
          content: `Profile Context:\n${context.profileSnapshot || "No profile context available."}`,
        },
        ...(context.selectedNotesSnapshot
          ? [
              {
                role: "system" as const,
                content: context.selectedNotesSnapshot,
              },
            ]
          : []),
        ...(context.selectedEmailsSnapshot
          ? [
              {
                role: "system" as const,
                content: context.selectedEmailsSnapshot,
              },
            ]
          : []),
        ...(context.selectedDocumentsSnapshot
          ? [
              {
                role: "system" as const,
                content: context.selectedDocumentsSnapshot,
              },
            ]
          : []),
        ...history,
        {
          role: "user",
          content: buildUserPromptContent(options.prompt, options.attachments),
        },
      ],
      jsonSchema: CHAT_RESPONSE_SCHEMA,
      maxRetries: 1,
      retryDelayMs: 300,
      jobId: options.jobId,
      signal: controller.signal,
    });

    if (!llmResult.success) {
      if (controller.signal.aborted) {
        throw requestTimeout("Chat generation was cancelled");
      }
      throw upstreamError("LLM generation failed", {
        reason: llmResult.error,
      });
    }

    const finalText = (llmResult.data.response || "").trim();
    const chunks = chunkText(finalText);

    for (const chunk of chunks) {
      if (controller.signal.aborted) {
        const cancelled = await jobChatRepo.updateMessage(assistantMessage.id, {
          content: accumulated,
          status: "cancelled",
          tokensIn: estimateTokenCount(options.prompt),
          tokensOut: estimateTokenCount(accumulated),
        });
        await jobChatRepo.completeRun(run.id, {
          status: "cancelled",
          errorCode: "REQUEST_TIMEOUT",
          errorMessage: "Generation cancelled by user",
        });
        options.stream?.onCancelled({ runId: run.id, message: cancelled });
        return {
          runId: run.id,
          messageId: assistantMessage.id,
          message: accumulated,
        };
      }

      accumulated += chunk;
      options.stream?.onDelta({
        runId: run.id,
        messageId: assistantMessage.id,
        delta: chunk,
      });
    }

    const completedMessage = await jobChatRepo.updateMessage(
      assistantMessage.id,
      {
        content: accumulated,
        status: "complete",
        tokensIn: estimateTokenCount(options.prompt),
        tokensOut: estimateTokenCount(accumulated),
      },
    );

    await jobChatRepo.completeRun(run.id, {
      status: "completed",
    });

    options.stream?.onCompleted({
      runId: run.id,
      message: completedMessage,
    });

    return {
      runId: run.id,
      messageId: assistantMessage.id,
      message: accumulated,
    };
  } catch (error) {
    const appError = error instanceof Error ? error : new Error(String(error));
    const isCancelled =
      controller.signal.aborted || appError.name === "AbortError";
    const status = isCancelled ? "cancelled" : "failed";
    const code = isCancelled ? "REQUEST_TIMEOUT" : "UPSTREAM_ERROR";
    const message = isCancelled
      ? "Generation cancelled by user"
      : appError.message || "Generation failed";

    const failedMessage = await jobChatRepo.updateMessage(assistantMessage.id, {
      content: accumulated,
      status: isCancelled ? "cancelled" : "failed",
      tokensIn: estimateTokenCount(options.prompt),
      tokensOut: estimateTokenCount(accumulated),
    });

    await jobChatRepo.completeRun(run.id, {
      status,
      errorCode: code,
      errorMessage: message,
    });

    if (isCancelled) {
      options.stream?.onCancelled({ runId: run.id, message: failedMessage });
      return {
        runId: run.id,
        messageId: assistantMessage.id,
        message: accumulated,
      };
    }

    options.stream?.onError({
      runId: run.id,
      code,
      message,
      requestId,
    });

    throw upstreamError(message, { runId: run.id });
  } finally {
    abortControllers.delete(run.id);
    logger.info("Job chat run finished", {
      jobId: options.jobId,
      threadId: options.threadId,
      runId: run.id,
    });
  }
}

export async function sendMessage(input: {
  jobId: string;
  threadId: string;
  content: string;
  attachments?: readonly JobChatImageAttachment[];
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const content = input.content.trim();
  if (!content) {
    throw badRequest("Message content is required");
  }

  const thread = await jobChatRepo.getThreadForJob(input.jobId, input.threadId);
  if (!thread) {
    throw notFound("Thread not found for this job");
  }
  if (
    input.selectedNoteIds !== undefined ||
    input.selectedEmailIds !== undefined ||
    input.selectedDocumentIds !== undefined
  ) {
    await updateThreadContext({
      jobId: input.jobId,
      threadId: input.threadId,
      selectedNoteIds: input.selectedNoteIds,
      selectedEmailIds: input.selectedEmailIds,
      selectedDocumentIds: input.selectedDocumentIds,
    });
  }
  const llmConfig = await resolveAndValidateImageInput(input.attachments);

  // Determine parent: last message on the current active path
  const activePath = await jobChatRepo.getActivePathFromRoot(input.threadId);
  const parentId =
    activePath.length > 0 ? activePath[activePath.length - 1].id : null;

  const userMessage = await jobChatRepo.createMessage({
    threadId: input.threadId,
    jobId: input.jobId,
    role: "user",
    content,
    attachments: input.attachments,
    status: "complete",
    tokensIn: estimateTokenCount(content),
    tokensOut: null,
    parentMessageId: parentId,
  });

  // Update parent's activeChildId to point to this new user message
  if (parentId) {
    await jobChatRepo.setActiveChild(parentId, userMessage.id);
  } else {
    // First message in thread — set as active root
    await jobChatRepo.setActiveRoot(input.threadId, userMessage.id);
  }

  const result = await runAssistantReply({
    jobId: input.jobId,
    threadId: input.threadId,
    prompt: content,
    attachments: input.attachments,
    llmConfig,
    parentMessageId: userMessage.id,
    stream: input.stream,
  });

  // Update user message's activeChildId to point to the assistant reply
  await jobChatRepo.setActiveChild(userMessage.id, result.messageId);

  const assistantMessage = await jobChatRepo.getMessageById(result.messageId);
  return {
    userMessage,
    assistantMessage,
    runId: result.runId,
  };
}

export async function sendMessageForJob(input: {
  jobId: string;
  content: string;
  attachments?: readonly JobChatImageAttachment[];
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const thread = await ensureJobThread(input.jobId);
  return sendMessage({
    jobId: input.jobId,
    threadId: thread.id,
    content: input.content,
    attachments: input.attachments,
    selectedNoteIds: input.selectedNoteIds,
    selectedEmailIds: input.selectedEmailIds,
    selectedDocumentIds: input.selectedDocumentIds,
    stream: input.stream,
  });
}

export async function regenerateMessage(input: {
  jobId: string;
  threadId: string;
  assistantMessageId: string;
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const thread = await jobChatRepo.getThreadForJob(input.jobId, input.threadId);
  if (!thread) {
    throw notFound("Thread not found for this job");
  }
  if (
    input.selectedNoteIds !== undefined ||
    input.selectedEmailIds !== undefined ||
    input.selectedDocumentIds !== undefined
  ) {
    await updateThreadContext({
      jobId: input.jobId,
      threadId: input.threadId,
      selectedNoteIds: input.selectedNoteIds,
      selectedEmailIds: input.selectedEmailIds,
      selectedDocumentIds: input.selectedDocumentIds,
    });
  }

  const target = await jobChatRepo.getMessageById(input.assistantMessageId);
  if (
    !target ||
    target.threadId !== input.threadId ||
    target.jobId !== input.jobId
  ) {
    throw notFound("Assistant message not found for this thread");
  }

  if (target.role !== "assistant") {
    throw badRequest("Only assistant messages can be regenerated");
  }

  // Find the parent user message (the user message that prompted this assistant reply).
  // With branching, the parent is stored directly in parentMessageId.
  let parentUserMessage: JobChatMessage | null = null;
  if (target.parentMessageId) {
    parentUserMessage = await jobChatRepo.getMessageById(
      target.parentMessageId,
    );
  }

  // Fallback for legacy messages without parentMessageId: walk backwards in time
  if (parentUserMessage?.role !== "user") {
    const messages = await jobChatRepo.listMessagesForThread(input.threadId, {
      limit: 200,
    });
    const targetIndex = messages.findIndex(
      (message) => message.id === target.id,
    );
    parentUserMessage =
      targetIndex > 0
        ? ([...messages.slice(0, targetIndex)]
            .reverse()
            .find((message) => message.role === "user") ?? null)
        : null;
  }

  if (!parentUserMessage) {
    throw badRequest("Could not find a user message to regenerate from");
  }

  // Create a new sibling assistant message with the same parent (the user message)
  const result = await runAssistantReply({
    jobId: input.jobId,
    threadId: input.threadId,
    prompt: parentUserMessage.content,
    attachments: parentUserMessage.attachments,
    replaceMessageId: target.id,
    version: (target.version || 1) + 1,
    parentMessageId: parentUserMessage.id,
    stream: input.stream,
  });

  // Update parent's activeChildId to the new assistant message (switch to new branch)
  await jobChatRepo.setActiveChild(parentUserMessage.id, result.messageId);

  const assistantMessage = await jobChatRepo.getMessageById(result.messageId);

  return {
    runId: result.runId,
    assistantMessage,
  };
}

export async function regenerateMessageForJob(input: {
  jobId: string;
  assistantMessageId: string;
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const thread = await ensureJobThread(input.jobId);
  return regenerateMessage({
    jobId: input.jobId,
    threadId: thread.id,
    assistantMessageId: input.assistantMessageId,
    selectedNoteIds: input.selectedNoteIds,
    selectedEmailIds: input.selectedEmailIds,
    selectedDocumentIds: input.selectedDocumentIds,
    stream: input.stream,
  });
}

export async function editMessage(input: {
  jobId: string;
  threadId: string;
  messageId: string;
  content: string;
  attachments?: readonly JobChatImageAttachment[];
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const content = input.content.trim();
  if (!content) {
    throw badRequest("Message content is required");
  }

  const thread = await jobChatRepo.getThreadForJob(input.jobId, input.threadId);
  if (!thread) {
    throw notFound("Thread not found for this job");
  }
  if (
    input.selectedNoteIds !== undefined ||
    input.selectedEmailIds !== undefined ||
    input.selectedDocumentIds !== undefined
  ) {
    await updateThreadContext({
      jobId: input.jobId,
      threadId: input.threadId,
      selectedNoteIds: input.selectedNoteIds,
      selectedEmailIds: input.selectedEmailIds,
      selectedDocumentIds: input.selectedDocumentIds,
    });
  }
  const llmConfig = await resolveAndValidateImageInput(input.attachments);

  const target = await jobChatRepo.getMessageById(input.messageId);
  if (
    !target ||
    target.threadId !== input.threadId ||
    target.jobId !== input.jobId
  ) {
    throw notFound("Message not found for this thread");
  }

  if (target.role !== "user") {
    throw badRequest("Only user messages can be edited");
  }

  // Create a new sibling user message (same parent as the original)
  const newUserMessage = await jobChatRepo.createMessage({
    threadId: input.threadId,
    jobId: input.jobId,
    role: "user",
    content,
    attachments: input.attachments,
    status: "complete",
    tokensIn: estimateTokenCount(content),
    tokensOut: null,
    parentMessageId: target.parentMessageId,
  });

  // Update the grandparent's activeChildId to point to the new user message
  if (target.parentMessageId) {
    await jobChatRepo.setActiveChild(target.parentMessageId, newUserMessage.id);
  } else {
    // Editing a root message — set the new message as active root
    await jobChatRepo.setActiveRoot(input.threadId, newUserMessage.id);
  }

  // Generate assistant reply as a child of the new user message
  const result = await runAssistantReply({
    jobId: input.jobId,
    threadId: input.threadId,
    prompt: content,
    attachments: input.attachments,
    llmConfig,
    parentMessageId: newUserMessage.id,
    stream: input.stream,
  });

  // Update new user message's activeChildId to the assistant reply
  await jobChatRepo.setActiveChild(newUserMessage.id, result.messageId);

  const assistantMessage = await jobChatRepo.getMessageById(result.messageId);
  return {
    userMessage: newUserMessage,
    assistantMessage,
    runId: result.runId,
  };
}

export async function editMessageForJob(input: {
  jobId: string;
  messageId: string;
  content: string;
  attachments?: readonly JobChatImageAttachment[];
  selectedNoteIds?: readonly string[];
  selectedEmailIds?: readonly string[];
  selectedDocumentIds?: readonly string[];
  stream?: GenerateReplyOptions["stream"];
}) {
  const thread = await ensureJobThread(input.jobId);
  return editMessage({
    jobId: input.jobId,
    threadId: thread.id,
    messageId: input.messageId,
    content: input.content,
    attachments: input.attachments,
    selectedNoteIds: input.selectedNoteIds,
    selectedEmailIds: input.selectedEmailIds,
    selectedDocumentIds: input.selectedDocumentIds,
    stream: input.stream,
  });
}

export async function switchBranch(input: {
  jobId: string;
  threadId: string;
  messageId: string;
}): Promise<{ messages: JobChatMessage[]; branches: BranchInfo[] }> {
  const thread = await jobChatRepo.getThreadForJob(input.jobId, input.threadId);
  if (!thread) {
    throw notFound("Thread not found for this job");
  }

  const target = await jobChatRepo.getMessageById(input.messageId);
  if (
    !target ||
    target.threadId !== input.threadId ||
    target.jobId !== input.jobId
  ) {
    throw notFound("Message not found for this thread");
  }

  if (target.parentMessageId) {
    // Update the parent's activeChildId to point to this sibling
    await jobChatRepo.setActiveChild(target.parentMessageId, target.id);
  } else {
    // Switching between root messages
    await jobChatRepo.setActiveRoot(input.threadId, target.id);
  }

  // Return the updated active path
  return listMessages({
    jobId: input.jobId,
    threadId: input.threadId,
  });
}

export async function switchBranchForJob(input: {
  jobId: string;
  messageId: string;
}): Promise<{ messages: JobChatMessage[]; branches: BranchInfo[] }> {
  const thread = await ensureJobThread(input.jobId);
  return switchBranch({
    jobId: input.jobId,
    threadId: thread.id,
    messageId: input.messageId,
  });
}

export async function cancelRun(input: {
  jobId: string;
  threadId: string;
  runId: string;
}): Promise<{ cancelled: boolean; alreadyFinished: boolean }> {
  const run = await jobChatRepo.getRunById(input.runId);
  if (!run || run.threadId !== input.threadId || run.jobId !== input.jobId) {
    throw notFound("Run not found for this thread");
  }

  if (run.status !== "running") {
    return {
      cancelled: false,
      alreadyFinished: true,
    };
  }

  const controller = abortControllers.get(input.runId);
  if (controller) {
    controller.abort();
  }

  const runAfterCancel = await jobChatRepo.completeRunIfRunning(input.runId, {
    status: "cancelled",
    errorCode: "REQUEST_TIMEOUT",
    errorMessage: "Generation cancelled by user",
  });

  if (runAfterCancel?.status !== "cancelled") {
    return {
      cancelled: false,
      alreadyFinished: true,
    };
  }

  return {
    cancelled: true,
    alreadyFinished: false,
  };
}

export async function resetConversationForJob(input: {
  jobId: string;
}): Promise<{ deletedMessages: number; deletedRuns: number }> {
  const thread = await ensureJobThread(input.jobId);

  const activeRun = await jobChatRepo.getActiveRunForThread(thread.id);
  if (activeRun) {
    const controller = abortControllers.get(activeRun.id);
    if (controller) {
      controller.abort();
    }
    await jobChatRepo.completeRunIfRunning(activeRun.id, {
      status: "cancelled",
      errorCode: "REQUEST_TIMEOUT",
      errorMessage: "Conversation reset by user",
    });
  }

  const deletedMessages = await jobChatRepo.deleteAllMessagesForThread(
    thread.id,
  );
  const deletedRuns = await jobChatRepo.deleteAllRunsForThread(thread.id);

  logger.info("Ghostwriter conversation reset", {
    jobId: input.jobId,
    threadId: thread.id,
    deletedMessages,
    deletedRuns,
  });

  return { deletedMessages, deletedRuns };
}

export async function cancelRunForJob(input: {
  jobId: string;
  runId: string;
}): Promise<{ cancelled: boolean; alreadyFinished: boolean }> {
  const thread = await ensureJobThread(input.jobId);
  return cancelRun({
    jobId: input.jobId,
    threadId: thread.id,
    runId: input.runId,
  });
}

const SCREENING_ANSWERS_SCHEMA: JsonSchemaDefinition = {
  name: "screening_answers",
  schema: {
    type: "object",
    properties: {
      answers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
};

const COVER_LETTER_SCHEMA: JsonSchemaDefinition = {
  name: "cover_letter",
  schema: {
    type: "object",
    properties: {
      intro: { type: "string" },
      body: { type: "string" },
      outro: { type: "string" },
      fullText: { type: "string" },
    },
    required: ["intro", "body", "outro", "fullText"],
    additionalProperties: false,
  },
};

function buildScreeningAnswersPrompt(
  questions: string[],
  job: { title?: string; employer?: string; jobDescription?: string | null },
  profile: Record<string, unknown>,
): string {
  const questionsList = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return [
    `Job: ${job.title ?? "Unknown"} at ${job.employer ?? "Unknown"}`,
    job.jobDescription
      ? `Job description:\n${job.jobDescription}`
      : "Job description: (not available)",
    "",
    "Candidate profile (JSON):",
    JSON.stringify(profile, null, 2),
    "",
    "Screening questions:",
    questionsList,
    "",
    'Return JSON of the form {"answers": { "<question>": "<answer>", ... }}.',
  ].join("\n");
}

const SCREENING_ANSWERS_SYSTEM_PROMPT = `You are an applicant filling out a job application screening form. You will be given a job description, the candidate's resume profile, and a list of screening questions. Return a JSON object with an "answers" property whose value is a map from each question to a concise, honest, role-specific answer based on the candidate's profile and the job description. Do not invent experience the profile does not support; if the profile does not address a question, say so briefly. Keep each answer to 1-3 sentences.`;

const SCREENING_ANSWERS_REPAIR_PROMPT = `You are filling out a job application screening form. Return a JSON object with an "answers" property mapping each question to a short answer (1-2 sentences). Use the candidate's profile information. If you don't know the answer, say "Not available in profile." Do not return empty answers.`;

/**
 * Error thrown when the screening answer LLM call fails on both the initial
 * attempt and a single retry with a repair prompt.
 */
export class ScreeningAnswersUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScreeningAnswersUnavailableError";
  }
}

/**
 * Error thrown when the screening answer response is missing answers for
 * one or more questions after a retry.
 */
export class ScreeningAnswersValidationError extends Error {
  constructor(
    message: string,
    public readonly missingQuestions: string[],
  ) {
    super(message);
    this.name = "ScreeningAnswersValidationError";
  }
}

/**
 * Error thrown when the cover letter fails length validation (must be in
 * [100, 5000] chars) after a single retry with a length-correcting prompt.
 * The caller (buildPayload) catches this and falls back to the configured
 * `autoApplicationDefaultCoverLetter` setting.
 */
export class CoverLetterValidationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "too_short"
      | "too_long"
      | "contradiction"
      | "invalid",
  ) {
    super(message);
    this.name = "CoverLetterValidationError";
  }
}

/**
 * Generate screening answers for the supplied custom questions using the
 * existing Ghostwriter LLM machinery. Returns `{ answers, missingQuestions }`
 * where `answers` is a `{ question: answer }` map with one entry per
 * successfully answered question, and `missingQuestions` lists questions
 * the LLM could not answer after a retry. Returns empty `answers` and an
 * empty `missingQuestions` array when there are no input questions.
 *
 * On LLM throw or JSON parse error, retries once with a repair prompt.
 * If the retry also fails, throws `ScreeningAnswersUnavailableError`.
 *
 * Validates that each question has a non-empty answer. If any are missing,
 * retries once. If the retry still has missing answers, they are returned
 * in `missingQuestions` rather than throwing.
 *
 * @param onChunk - Optional callback invoked with each chunk of the
 *   screening answers JSON as it becomes available. The streaming is
 *   informational (the final result is still returned).
 */
export async function generateScreeningAnswersForJob(input: {
  jobId: string;
  profile: Record<string, unknown>;
  questions: string[];
  onChunk?: (chunk: string) => void;
}): Promise<{ answers: Record<string, string>; missingQuestions: string[] }> {
  if (input.questions.length === 0) {
    return { answers: {}, missingQuestions: [] };
  }

  const job = await jobsRepo.getJobById(input.jobId);
  if (!job) {
    throw notFound(`Job ${input.jobId} not found for screening answers`);
  }

  const llmConfig = await resolveLlmRuntimeSettings();
  const prompt = buildScreeningAnswersPrompt(
    input.questions,
    job,
    input.profile,
  );

  const llm = new LlmService({
    provider: llmConfig.provider,
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey,
  });

  // Attempt 1: original prompt
  let answers = await callLlmWithRetry(
    llm,
    llmConfig.model,
    prompt,
    SCREENING_ANSWERS_SYSTEM_PROMPT,
    input.jobId,
  );

  // Validate: check for missing answers
  const missingQuestions = findMissingAnswers(input.questions, answers);
  if (missingQuestions.length > 0) {
    logger.info("Screening answers have missing responses, retrying once", {
      jobId: input.jobId,
      missingCount: missingQuestions.length,
    });

    // Attempt 2: repair prompt for missing answers
    const repairPrompt = buildRepairPrompt(
      input.questions,
      answers,
      input.profile,
      job,
    );
    const retryAnswers = await callLlmWithRetry(
      llm,
      llmConfig.model,
      repairPrompt,
      SCREENING_ANSWERS_REPAIR_PROMPT,
      input.jobId,
    );

    // Merge: keep original answers, fill missing from retry
    const merged: Record<string, string> = { ...answers };
    for (const question of input.questions) {
      if (!merged[question] && retryAnswers[question]) {
        merged[question] = retryAnswers[question];
      }
    }
    answers = merged;

    // Validate again after retry — return partial success instead of throwing
    const stillMissing = findMissingAnswers(input.questions, answers);
    if (stillMissing.length > 0) {
      logger.warn(
        "Screening answers still missing after retry, returning partial",
        {
          jobId: input.jobId,
          missingCount: stillMissing.length,
        },
      );
      return { answers, missingQuestions: stillMissing };
    }
  }

  // Emit streaming chunks
  if (input.onChunk) {
    const json = JSON.stringify(answers);
    for (let i = 0; i < json.length; i += 128) {
      input.onChunk(json.slice(i, i + 128));
    }
  }

  return { answers, missingQuestions: [] };
}

async function callLlmWithRetry(
  llm: InstanceType<typeof LlmService>,
  model: string,
  prompt: string,
  systemPrompt: string,
  jobId: string,
): Promise<Record<string, string>> {
  // Attempt 1
  let llmResult: Awaited<
    ReturnType<typeof llm.callJson<{ answers: Record<string, string> }>>
  >;
  try {
    llmResult = await llm.callJson<{ answers: Record<string, string> }>({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      jsonSchema: SCREENING_ANSWERS_SCHEMA,
      jobId,
      maxRetries: 3,
      retryDelayMs: 1000,
    });
  } catch (error) {
    logger.warn("Screening answer LLM call threw, retrying once", {
      jobId,
      error,
    });
    // Retry with repair prompt
    try {
      const retrySystemPrompt = SCREENING_ANSWERS_REPAIR_PROMPT;
      const retryResult = await llm.callJson<{
        answers: Record<string, string>;
      }>({
        model,
        messages: [
          { role: "system", content: retrySystemPrompt },
          { role: "user", content: prompt },
        ],
        jsonSchema: SCREENING_ANSWERS_SCHEMA,
        jobId,
        maxRetries: 3,
        retryDelayMs: 1000,
      });
      if (!retryResult.success) {
        throw new ScreeningAnswersUnavailableError(
          `Screening answer generation failed after retry: ${retryResult.error ?? "unknown error"}`,
          error,
        );
      }
      const rawAnswers = retryResult.data.answers ?? {};
      const normalized: Record<string, string> = {};
      for (const [q, a] of Object.entries(rawAnswers)) {
        normalized[q] = typeof a === "string" ? a : "";
      }
      return normalized;
    } catch (retryError) {
      if (retryError instanceof ScreeningAnswersUnavailableError) {
        throw retryError;
      }
      throw new ScreeningAnswersUnavailableError(
        `Screening answer generation failed after retry: ${retryError instanceof Error ? retryError.message : "unknown error"}`,
        retryError,
      );
    }
  }

  if (!llmResult.success) {
    // Attempt 2: retry with same prompt
    const retryResult = await llm.callJson<{ answers: Record<string, string> }>(
      {
        model,
        messages: [
          { role: "system", content: SCREENING_ANSWERS_REPAIR_PROMPT },
          { role: "user", content: prompt },
        ],
        jsonSchema: SCREENING_ANSWERS_SCHEMA,
        jobId,
        maxRetries: 3,
        retryDelayMs: 1000,
      },
    );
    if (!retryResult.success) {
      throw new ScreeningAnswersUnavailableError(
        `Screening answer generation failed after retry: ${retryResult.error ?? "unknown error"}`,
      );
    }
    const rawAnswers = retryResult.data.answers ?? {};
    const normalized: Record<string, string> = {};
    for (const [q, a] of Object.entries(rawAnswers)) {
      normalized[q] = typeof a === "string" ? a : "";
    }
    return normalized;
  }

  const rawAnswers = llmResult.data.answers ?? {};
  const normalized: Record<string, string> = {};
  for (const [q, a] of Object.entries(rawAnswers)) {
    normalized[q] = typeof a === "string" ? a : "";
  }
  return normalized;
}

function findMissingAnswers(
  questions: string[],
  answers: Record<string, string>,
): string[] {
  return questions.filter((q) => !answers[q] || answers[q].length === 0);
}

function buildRepairPrompt(
  questions: string[],
  currentAnswers: Record<string, string>,
  profile: Record<string, unknown>,
  job: { title?: string; employer?: string; jobDescription?: string | null },
): string {
  const answered = questions
    .filter((q) => currentAnswers[q])
    .map((q) => `${q} → ${currentAnswers[q]}`)
    .join("\n");
  const unanswered = questions
    .filter((q) => !currentAnswers[q])
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  return [
    `Job: ${job.title ?? "Unknown"} at ${job.employer ?? "Unknown"}`,
    job.jobDescription
      ? `Job description:\n${job.jobDescription}`
      : "Job description: (not available)",
    "",
    "Candidate profile (JSON):",
    JSON.stringify(profile, null, 2),
    "",
    answered ? `Already answered:\n${answered}` : "",
    "",
    `Please answer ONLY these remaining questions:\n${unanswered}`,
    "",
    "Keep each answer to 1-2 sentences. If you don't know, say 'Not available in profile.'",
    "",
    'Return JSON of the form {"answers": { "<question>": "<answer>", ... }}.',
  ]
    .filter(Boolean)
    .join("\n");
}
export async function generateCoverLetterForJob(input: {
  jobId: string;
  profile: Record<string, unknown>;
  screeningAnswers?: Record<string, string>;
  onChunk?: (chunk: string) => void;
}): Promise<string> {
  const job = await jobsRepo.getJobById(input.jobId);
  if (!job) {
    throw notFound(`Job ${input.jobId} not found for cover letter`);
  }

  const llmConfig = await resolveLlmRuntimeSettings();
  const prompt = buildCoverLetterPrompt(
    job,
    input.profile,
    input.screeningAnswers,
  );

  const llm = new LlmService({
    provider: llmConfig.provider,
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey,
  });

  // Attempt 1: original prompt
  let parsed: CoverLetterStructured | null = await callCoverLetterLlm(
    llm,
    llmConfig.model,
    COVER_LETTER_SYSTEM_PROMPT,
    prompt,
    input.jobId,
  );

  // Validate: length and contradictions
  let validation: CoverLetterValidationFailure | null = parsed
    ? validateCoverLetter(parsed, input.screeningAnswers)
    : {
        reason: "invalid" as const,
        message: "LLM returned no structured output",
      };

  if (validation) {
    logger.info("Cover letter failed validation, retrying once", {
      jobId: input.jobId,
      reason: validation.reason,
      message: validation.message,
    });

    // Attempt 2: repair prompt targeted at the specific failure
    const repairSystemPrompt = buildCoverLetterRepairSystemPrompt(
      validation.reason,
    );
    const repairUserPrompt = `${prompt}\n\n---\n\nPrevious attempt failed validation: ${validation.message}\n\n${buildCoverLetterRepairGuidance(validation.reason, input.screeningAnswers)}`;

    parsed = await callCoverLetterLlm(
      llm,
      llmConfig.model,
      repairSystemPrompt,
      repairUserPrompt,
      input.jobId,
    );

    validation = parsed
      ? validateCoverLetter(parsed, input.screeningAnswers)
      : {
          reason: "invalid" as const,
          message: "Repair attempt returned no structured output",
        };
  }

  if (validation || !parsed) {
    throw new CoverLetterValidationError(
      validation?.message ?? "Cover letter validation failed",
      validation?.reason ?? "invalid",
    );
  }

  const fullText = parsed.fullText.trim();

  // Emit streaming chunks (informational; consumers can also use the final string)
  if (input.onChunk) {
    for (let i = 0; i < fullText.length; i += 128) {
      input.onChunk(fullText.slice(i, i + 128));
    }
  }

  return fullText;
}

type CoverLetterStructured = {
  intro: string;
  body: string;
  outro: string;
  fullText: string;
};

type CoverLetterValidationReason =
  | "too_short"
  | "too_long"
  | "contradiction"
  | "invalid";

type CoverLetterValidationFailure = {
  reason: CoverLetterValidationReason;
  message: string;
};

const COVER_LETTER_MIN_CHARS = 100;
const COVER_LETTER_MAX_CHARS = 5000;

async function callCoverLetterLlm(
  llm: InstanceType<typeof LlmService>,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  jobId: string,
): Promise<CoverLetterStructured | null> {
  const result = await llm.callJson<CoverLetterStructured>({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    jsonSchema: COVER_LETTER_SCHEMA,
    jobId,
    maxRetries: 3,
    retryDelayMs: 1000,
  });
  if (!result.success) {
    logger.warn("Cover letter LLM call returned failure", {
      jobId,
      error: result.error,
    });
    return null;
  }
  const data = result.data;
  if (
    !data ||
    typeof data.intro !== "string" ||
    typeof data.body !== "string" ||
    typeof data.outro !== "string" ||
    typeof data.fullText !== "string"
  ) {
    return null;
  }
  return data;
}

function validateCoverLetter(
  parsed: CoverLetterStructured,
  screeningAnswers: Record<string, string> | undefined,
): CoverLetterValidationFailure | null {
  const text = (parsed.fullText ?? "").trim();
  if (text.length < COVER_LETTER_MIN_CHARS) {
    return {
      reason: "too_short",
      message: `Cover letter length ${text.length} is below minimum ${COVER_LETTER_MIN_CHARS} chars`,
    };
  }
  if (text.length > COVER_LETTER_MAX_CHARS) {
    return {
      reason: "too_long",
      message: `Cover letter length ${text.length} exceeds maximum ${COVER_LETTER_MAX_CHARS} chars`,
    };
  }
  // Cross-reference: if screening answers mention numeric/duration claims,
  // the cover letter should not contradict them. We extract simple "N years"
  // / "N months" patterns from each side and check for mismatches.
  if (screeningAnswers) {
    const contradiction = findDurationContradiction(text, screeningAnswers);
    if (contradiction) {
      return {
        reason: "contradiction",
        message: `Cover letter contradicts screening answer: ${contradiction}`,
      };
    }
  }
  return null;
}

/**
 * Extract "<N> (year|years|month|months|week|weeks|day|days)" claims from
 * text. Returns a list of "<n> <unit>" strings normalized to lowercase.
 */
function extractDurationClaims(text: string): string[] {
  const re = /(\d+)\s+(year|years|month|months|week|weeks|day|days)\b/gi;
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    out.push(`${m[1]} ${m[2].toLowerCase()}`);
  }
  return out;
}

/**
 * Compare duration claims in the cover letter with those in the screening
 * answers. Returns a human-readable description of the first contradiction,
 * or null if no contradiction is detected.
 */
function findDurationContradiction(
  coverLetter: string,
  screeningAnswers: Record<string, string>,
): string | null {
  const coverClaims = new Set(extractDurationClaims(coverLetter));
  for (const answer of Object.values(screeningAnswers)) {
    const answerClaims = extractDurationClaims(answer);
    for (const claim of answerClaims) {
      // Cover letter should either repeat the same claim or not mention
      // the duration at all. If it does mention a duration, it must match.
      if (!coverClaims.has(claim)) {
        // Check whether the cover letter mentions a different number of
        // the same unit (e.g., screening says "5 years" and cover letter
        // says "3 years").
        const [, unit] = claim.split(" ");
        for (const c of coverClaims) {
          const [cN, cUnit] = c.split(" ");
          if (cUnit === unit && cN !== claim.split(" ")[0]) {
            return `screening says "${claim}" but cover letter says "${c}"`;
          }
        }
      }
    }
  }
  return null;
}

function buildCoverLetterRepairSystemPrompt(
  reason: CoverLetterValidationReason,
): string {
  if (reason === "too_short") {
    return `${COVER_LETTER_SYSTEM_PROMPT}\n\nIMPORTANT: The previous version was too short. The fullText MUST be at least ${COVER_LETTER_MIN_CHARS} characters. Add more specific examples from the candidate's profile.`;
  }
  if (reason === "too_long") {
    return `${COVER_LETTER_SYSTEM_PROMPT}\n\nIMPORTANT: The previous version was too long. The fullText MUST be at most ${COVER_LETTER_MAX_CHARS} characters. Trim filler and keep only the strongest 2-3 specific examples.`;
  }
  if (reason === "contradiction") {
    return `${COVER_LETTER_SYSTEM_PROMPT}\n\nIMPORTANT: The previous version contradicted the candidate's screening answers on duration. Use the EXACT same duration claims as the screening answers; do not invent different numbers.`;
  }
  return COVER_LETTER_SYSTEM_PROMPT;
}

function buildCoverLetterRepairGuidance(
  reason: CoverLetterValidationReason,
  screeningAnswers: Record<string, string> | undefined,
): string {
  if (reason === "contradiction" && screeningAnswers) {
    const claims: string[] = [];
    for (const a of Object.values(screeningAnswers)) {
      claims.push(...extractDurationClaims(a));
    }
    if (claims.length > 0) {
      return `Use these duration claims exactly: ${claims.join("; ")}.`;
    }
  }
  return `Re-write to satisfy: ${reason}.`;
}

const COVER_LETTER_SYSTEM_PROMPT = `You are writing a concise, role-specific cover letter for a job application. You will be given a job description, the candidate's resume profile, and (when available) the candidate's screening answers. Write a 3-paragraph letter that connects the candidate's most relevant experience to the role, names the company, and ends with a clear call to action. Do not invent experience the profile does not support. Use the EXACT same duration claims (e.g. "5 years of React") that appear in the screening answers. Keep the tone professional and warm.

Return JSON of the form:
{"intro": "<greeting + 1-2 sentence role-fit summary>", "body": "<1-2 paragraphs of specific experience matching the role's requirements>", "outro": "<1-2 sentence call to action>", "fullText": "<intro + body + outro concatenated, separated by blank lines>"}.`;

function buildCoverLetterPrompt(
  job: { title?: string; employer?: string; jobDescription?: string | null },
  profile: Record<string, unknown>,
  screeningAnswers?: Record<string, string>,
): string {
  const sections: string[] = [
    `Job: ${job.title ?? "Unknown"} at ${job.employer ?? "Unknown"}`,
    job.jobDescription
      ? `Job description:\n${job.jobDescription}`
      : "Job description: (not available)",
    "",
    "Candidate profile (JSON):",
    JSON.stringify(profile, null, 2),
  ];
  if (screeningAnswers && Object.keys(screeningAnswers).length > 0) {
    sections.push(
      "",
      "Screening answers the candidate will submit for this job (the cover letter MUST be consistent with these answers):",
      JSON.stringify(screeningAnswers, null, 2),
    );
  }
  return sections.join("\n");
}
