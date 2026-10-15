import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/db";
import { workspaces } from "@/worker/db/schema";

describe("test database", () => {
  it("applies the real migrations", async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({ id: "w", name: "W", slug: "w" });
    expect(await db.select().from(workspaces)).toHaveLength(1);
  });
});
