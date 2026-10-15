import { z } from "zod";
import { AppError } from "@/shared/errors";
import { isNoResultsTask, isTaskInProgress, type TaskLike } from "./envelope";
import type { MapResult, TaskOutcome } from "./types";

// Fields we read from a Maps / Local Finder item; everything else is ignored.
// Business rows carry type "maps_search" (Maps) or "local_finder" (Local
// Finder); ads and other item types are skipped.
const ratingSchema = z
  .object({ value: z.number().nullable().optional(), votes_count: z.number().nullable().optional() })
  .nullable()
  .optional();

const itemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().optional(),
    rank_absolute: z.number().optional(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    place_id: z.string().nullable().optional(),
    cid: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    rating: ratingSchema,
  })
  .passthrough();

const BUSINESS_ITEM_TYPES = new Set(["maps_search", "local_finder"]);

export function parseMapItems(items: unknown): MapResult[] {
  const parsed = z.array(itemSchema).safeParse(items ?? []);
  if (!parsed.success) {
    console.error("dataforseo.invalid-payload", parsed.error.issues.slice(0, 5));
    throw new AppError("INTERNAL_ERROR", "DataForSEO returned an invalid Maps response shape");
  }
  const results: MapResult[] = [];
  for (const item of parsed.data) {
    if (!BUSINESS_ITEM_TYPES.has(item.type) || !item.title) continue;
    const rank = item.rank_group ?? item.rank_absolute;
    if (rank === undefined) continue;
    results.push({
      rank,
      name: item.title,
      placeId: item.place_id ?? null,
      cid: item.cid ?? null,
      domain: item.domain ?? null,
      rating: item.rating?.value ?? null,
      ratingCount: item.rating?.votes_count ?? null,
      category: item.category ?? null,
      address: item.address ?? null,
    });
  }
  return results.sort((a, b) => a.rank - b.rank);
}

export function firstResultItems(task: TaskLike): unknown {
  const first = task.result?.[0];
  return typeof first === "object" && first !== null ? (first as { items?: unknown }).items : [];
}

/**
 * Interprets one task_get task. Shared by the live client and the mock, so
 * the fixtures exercise exactly the code that parses real responses.
 */
export function taskToOutcome(task: TaskLike): TaskOutcome {
  if (isTaskInProgress(task)) return { status: "pending" };
  if (task.status_code !== 20000) {
    // "No Search Results" is a billed empty SERP, not a failure.
    if (isNoResultsTask(task)) return { status: "completed", items: [] };
    return { status: "failed", message: task.status_message || `DataForSEO task failed (${task.status_code})` };
  }
  return { status: "completed", items: parseMapItems(firstResultItems(task)), raw: task.result?.[0] };
}
