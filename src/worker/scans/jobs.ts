export type ScanJob =
  /** Submit every grid point to DataForSEO (queued modes) or fan out live searches. */
  | { type: "post"; scanId: string }
  /** Collect queued tasks for some points; re-enqueues itself while any are pending. */
  | { type: "collect"; scanId: string; pointIds: string[] }
  /** Run live searches for some points. */
  | { type: "live"; scanId: string; pointIds: string[] }
  /** Google Business Profile snapshot: profile call, then the reviews task_post. */
  | { type: "gbp_snapshot"; snapshotId: string }
  /** Collect the snapshot's reviews task; re-enqueues itself with backoff while pending. */
  | { type: "gbp_reviews_collect"; snapshotId: string; attempt: number };

export type GbpJob = Extract<ScanJob, { type: "gbp_snapshot" | "gbp_reviews_collect" }>;

/** The slice of a Cloudflare Queue the scan engine uses; tests swap in a fake. */
export interface ScanQueue {
  send(job: ScanJob, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(jobs: Array<{ body: ScanJob; delaySeconds?: number }>): Promise<void>;
}

/** Points handled per job. Sized to stay under Workers' subrequest limits. */
export const COLLECT_CHUNK = 25;
export const LIVE_CHUNK = 20;
