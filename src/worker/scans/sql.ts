// Bulk writes through json_each: one statement and one bound parameter carry
// any number of rows. D1 caps a statement at 100 bound parameters and Workers
// cap queries per invocation, so row-per-statement inserts do not scale to a
// 13x13 grid with 20 results per point.
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { execRaw } from "../db/raw";

export type PointInsert = { id: string; row: number; col: number; lat: number; lng: number };

export async function insertPoints(db: Db, scanId: string, points: PointInsert[]) {
  if (points.length === 0) return;
  await execRaw(db, sql`
    INSERT INTO scan_points (id, scan_id, "row", "col", lat, lng)
    SELECT json_extract(j.value, '$.id'), ${scanId}, json_extract(j.value, '$.row'),
           json_extract(j.value, '$.col'), json_extract(j.value, '$.lat'), json_extract(j.value, '$.lng')
    FROM json_each(${JSON.stringify(points)}) AS j`);
}

export type PointUpdate = {
  id: string;
  status: "posted" | "completed" | "failed";
  taskId?: string | null;
  rank?: number | null;
  error?: string | null;
};

/** Applies status/task/rank/error per point id in one statement. */
export async function updatePoints(db: Db, updates: PointUpdate[]) {
  if (updates.length === 0) return;
  await execRaw(db, sql`
    UPDATE scan_points SET
      status = json_extract(j.value, '$.status'),
      task_id = COALESCE(json_extract(j.value, '$.taskId'), scan_points.task_id),
      rank = json_extract(j.value, '$.rank'),
      error = json_extract(j.value, '$.error')
    FROM json_each(${JSON.stringify(updates.map((u) => ({ taskId: null, rank: null, error: null, ...u })))}) AS j
    WHERE scan_points.id = json_extract(j.value, '$.id')`);
}

export type ResultInsert = {
  id: string;
  pointId: string;
  rank: number;
  businessKey: string;
  name: string;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  address: string | null;
  isTarget: boolean;
};

export async function insertResults(db: Db, scanId: string, rows: ResultInsert[]) {
  if (rows.length === 0) return;
  await execRaw(db, sql`
    INSERT INTO scan_results (id, scan_id, point_id, rank, business_key, name, place_id, cid, domain,
                              rating, rating_count, category, address, is_target)
    SELECT json_extract(j.value, '$.id'), ${scanId}, json_extract(j.value, '$.pointId'),
           json_extract(j.value, '$.rank'), json_extract(j.value, '$.businessKey'),
           json_extract(j.value, '$.name'), json_extract(j.value, '$.placeId'),
           json_extract(j.value, '$.cid'), json_extract(j.value, '$.domain'),
           json_extract(j.value, '$.rating'), json_extract(j.value, '$.ratingCount'),
           json_extract(j.value, '$.category'), json_extract(j.value, '$.address'),
           json_extract(j.value, '$.isTarget')
    FROM json_each(${JSON.stringify(rows)}) AS j`);
}
