import { eq } from "drizzle-orm";
import type { Db } from "@/worker/db";
import { businesses, gbpSnapshots } from "@/worker/db/schema";
import { MockDataForSeo } from "@/worker/dataforseo/mock";
import type { BilledProvider, DataForSeoProvider } from "@/worker/dataforseo/types";
import { seedTracker } from "./harness";

/** The mock with some methods replaced, to inject failures or extra reviews. */
export function wrapProvider(inner: MockDataForSeo, overrides: Partial<DataForSeoProvider & BilledProvider>): DataForSeoProvider {
  const { postTasks, liveSearch, getBusinessProfile, postReviewsTask, ...free } = overrides;
  const billed: BilledProvider = {
    postTasks: postTasks ?? inner.postTasks.bind(inner),
    liveSearch: liveSearch ?? inner.liveSearch.bind(inner),
    getBusinessProfile: getBusinessProfile ?? inner.getBusinessProfile.bind(inner),
    postReviewsTask: postReviewsTask ?? inner.postReviewsTask.bind(inner),
  };
  return {
    mode: "mock",
    getTask: inner.getTask.bind(inner),
    getReviewsTask: inner.getReviewsTask.bind(inner),
    billed: () => billed,
    ...free,
  };
}

/** A business with a place ID in the workspace; returns its id. */
export async function seedBusiness(db: Db, workspaceId: string, business: Partial<typeof businesses.$inferInsert> = {}) {
  const { businessId } = await seedTracker(db, workspaceId, { business });
  return businessId;
}

export async function snapshotsOf(db: Db, businessId: string) {
  return db.select().from(gbpSnapshots).where(eq(gbpSnapshots.businessId, businessId)).orderBy(gbpSnapshots.takenAt);
}

export const DAY_MS = 86_400_000;
