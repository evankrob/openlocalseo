// Response-envelope handling, ported from open-seo's
// src/server/lib/dataforseo/envelope.ts (MIT): task status ladder and
// per-call billing metadata. Trimmed to what the Maps / Local Finder
// endpoints need.
import { z } from "zod";
import { AppError, type ErrorCode } from "@/shared/errors";
import type { CallBilling } from "./types";

export interface TaskLike {
  id?: string;
  status_code?: number;
  status_message?: string;
  path?: string[];
  cost?: number;
  result?: unknown[] | null;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponseLike<T extends TaskLike = TaskLike> {
  status_code?: number;
  status_message?: string;
  tasks?: T[];
  [key: string]: unknown;
}

/** Thrown when a task failed after DataForSEO billed it; the cost still counts. */
export class ChargedTaskError extends AppError {
  constructor(
    message: string,
    public readonly billing: CallBilling,
    code: ErrorCode = "INTERNAL_ERROR",
  ) {
    super(code, message);
    this.name = "ChargedTaskError";
  }
}

const billingSchema = z.object({ path: z.array(z.string()), cost: z.number() });

export function buildTaskBilling(task: TaskLike): CallBilling {
  const parsed = billingSchema.safeParse(task);
  if (!parsed.success) {
    throw new AppError("INTERNAL_ERROR", "DataForSEO task is missing billing metadata (path/cost)");
  }
  return { path: parsed.data.path, costUsd: parsed.data.cost };
}

/** "No Search Results" (40501) is a billed, empty, successful SERP. */
export function isNoResultsTask(task: TaskLike): boolean {
  return task.status_message?.toLowerCase().includes("no search results") ?? false;
}

// Task Created / Task Handed / Task In Queue: not done yet, not a failure.
const IN_PROGRESS = new Set([20100, 40601, 40602]);
export function isTaskInProgress(task: TaskLike): boolean {
  return task.status_code !== undefined && IN_PROGRESS.has(task.status_code);
}

// DataForSEO's own backend failing on an HTTP 200: a provider flake, not our bug.
const UPSTREAM_FAILURES = new Set([40101, 40103, 50000, 50301, 50302, 50303, 50304, 50401, 50402]);
export function isUpstreamFailureStatus(code: number | undefined): boolean {
  return code !== undefined && UPSTREAM_FAILURES.has(code);
}

export function failedResponseError(response: ResponseLike | null, fallback: string): AppError {
  return new AppError(
    isUpstreamFailureStatus(response?.status_code) ? "UPSTREAM_UNAVAILABLE" : "INTERNAL_ERROR",
    response?.status_message || fallback,
  );
}

/** Validates the response and its first task; returns that task. */
export function assertOk<T extends TaskLike>(
  response: ResponseLike<T> | null,
  options: { treatNoResultsAsEmpty?: boolean; okTaskStatusCode?: number } = {},
): T {
  if (!response) throw new AppError("INTERNAL_ERROR", "DataForSEO returned an empty response");
  if (response.status_code !== 20000) {
    throw failedResponseError(response, "DataForSEO request failed");
  }
  const task = response.tasks?.[0];
  if (!task) throw new AppError("INTERNAL_ERROR", "DataForSEO response missing task");
  if (task.status_code !== (options.okTaskStatusCode ?? 20000)) {
    if (options.treatNoResultsAsEmpty && isNoResultsTask(task)) return task;
    const message = task.status_message || "DataForSEO task failed";
    const code: ErrorCode = isUpstreamFailureStatus(task.status_code)
      ? "UPSTREAM_UNAVAILABLE"
      : "INTERNAL_ERROR";
    const billing = billingSchema.safeParse(task);
    if (billing.success) {
      throw new ChargedTaskError(message, { path: billing.data.path, costUsd: billing.data.cost }, code);
    }
    throw new AppError(code, message);
  }
  return task;
}
