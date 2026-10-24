// "Profile & reviews": the tracked Google Business Profile of one business.
// Rating and review-count trend from monthly snapshots, review velocity,
// unanswered reviews, profile health, the latest reviews, the opt-in monthly
// tracking toggle (with its cost) and an on-demand refresh (with its quote).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { get, patch, post } from "../lib/api";
import { fmtDate, fmtNum, fmtUsd } from "../lib/format";
import type { GbpOverview, GbpQuote, ReviewPage, ReviewView } from "../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorNote, Spinner, Stat } from "./ui";

const ACTIVE = ["queued", "running"];

const gbpKey = (businessId: string) => ["gbp", businessId] as const;

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={n <= value ? "size-3.5 fill-warning text-warning" : "size-3.5 text-muted-foreground/40"} />
      ))}
    </span>
  );
}

const signed = (n: number | null | undefined, digits = 0) => (n == null ? null : `${n > 0 ? "+" : ""}${n.toFixed(digits)}`);

function Sparkline({ history }: { history: GbpOverview["history"] }) {
  const rows = history.filter((h) => h.rating !== null).map((h) => ({ date: fmtDate(h.takenAt), rating: h.rating as number }));
  if (rows.length < 2) return <p className="text-xs text-muted-foreground">The rating trend appears after the second snapshot.</p>;
  const values = rows.map((r) => r.rating);
  const lo = Math.max(1, Math.floor((Math.min(...values) - 0.1) * 10) / 10);
  const hi = Math.min(5, Math.ceil((Math.max(...values) + 0.1) * 10) / 10);
  return (
    <div className="h-16" role="img" aria-label={`Rating over time: ${rows.map((r) => `${r.date} ${fmtNum(r.rating)}`).join(", ")}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 6, left: 8 }}>
          <YAxis hide domain={[lo, hi]} />
          <Tooltip
            formatter={(v) => [fmtNum(Number(v)), "Rating"]}
            contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
          />
          <Line type="monotone" dataKey="rating" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 3, stroke: "var(--card)", strokeWidth: 1.5, fill: "var(--series-1)" }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ReviewRow({ review }: { review: ReviewView }) {
  return (
    <li className="space-y-1 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Stars value={review.rating} />
        <span className="text-xs text-muted-foreground">{fmtDate(review.publishedAt)}</span>
        {review.reviewerName && <span className="text-xs text-muted-foreground">by {review.reviewerName}</span>}
        <Badge tone={review.ownerAnswered ? "success" : "warning"}>{review.ownerAnswered ? "Answered" : "Unanswered"}</Badge>
      </div>
      {review.text && <p className="text-sm">{review.text}</p>}
    </li>
  );
}

function Reviews({ businessId }: { businessId: string }) {
  const [unanswered, setUnanswered] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["gbp", businessId, "reviews", unanswered],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      get<ReviewPage>(`/businesses/${businessId}/reviews?limit=10${unanswered ? "&unanswered=1" : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const reviews = q.data?.pages.flatMap((p) => p.reviews) ?? [];
  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-5 py-3">
        <h3 className="text-sm font-semibold">Latest reviews</h3>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={unanswered} onChange={(e) => setUnanswered(e.target.checked)} /> Unanswered only
        </label>
      </div>
      <ErrorNote error={q.error} />
      {q.isLoading ? (
        <div className="px-5 pb-4"><Spinner /></div>
      ) : reviews.length === 0 ? (
        <EmptyState title={unanswered ? "No unanswered reviews" : "No reviews stored yet"}>
          {unanswered ? "Every review we have seen has an owner reply." : "Refresh the profile to fetch the newest reviews."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/60">{reviews.map((r) => <ReviewRow key={r.reviewId} review={r} />)}</ul>
      )}
      {q.hasNextPage && (
        <div className="px-5 py-3">
          <Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading" : "Show more"}</Button>
        </div>
      )}
    </div>
  );
}

function costLabel(quote: GbpQuote, billingMode: "byok" | "hosted") {
  return billingMode === "hosted" ? `${quote.credits} credits (${fmtUsd(quote.chargedUsd)})` : fmtUsd(quote.chargedUsd);
}

export function GbpPanel({ businessId, billingMode }: { businessId: string; billingMode: "byok" | "hosted" }) {
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: gbpKey(businessId),
    queryFn: () => get<GbpOverview>(`/businesses/${businessId}/gbp`),
    // Poll while a snapshot is in flight.
    refetchInterval: (query) => (query.state.data?.attempt && ACTIVE.includes(query.state.data.attempt.status) ? 3000 : false),
  });
  const refresh = useMutation({
    mutationFn: (maxCostUsd: number) => post(`/businesses/${businessId}/gbp/refresh`, { maxCostUsd }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gbpKey(businessId) }),
  });
  const toggle = useMutation({
    mutationFn: (gbpTracking: boolean) => patch(`/businesses/${businessId}`, { gbpTracking }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gbpKey(businessId) }),
  });

  if (overview.isLoading) return <Spinner />;
  if (!overview.data) return <ErrorNote error={overview.error} />;
  const { business, latest, change, attempt, history, quote } = overview.data;
  const running = attempt !== null && ACTIVE.includes(attempt.status);
  const hasPlaceId = Boolean(business.placeId);

  return (
    <Card>
      <CardHeader
        title="Profile & reviews"
        description="Rating, reviews and profile health from the Google Business Profile."
        actions={
          <Button
            size="sm"
            disabled={!hasPlaceId || running || refresh.isPending}
            // The quote shown on the button is also the approved ceiling, so the charge cannot be higher.
            onClick={() => refresh.mutate(quote.chargedUsd)}
          >
            {running ? "Refreshing..." : `Refresh now · ${costLabel(quote, billingMode)}`}
          </Button>
        }
      />
      <div className="space-y-4 p-5">
        <ErrorNote error={refresh.error ?? toggle.error ?? overview.error} />
        {!hasPlaceId && (
          <p className="text-sm text-muted-foreground">This business has no Google place ID, so its profile cannot be tracked. Add the business again with the place ID (it starts with ChIJ).</p>
        )}
        {running && (
          <p className="flex items-center gap-2 text-sm" role="status"><Spinner /> Fetching the profile and newest reviews. This usually takes under a minute.</p>
        )}
        {attempt?.status === "failed" && <ErrorNote error={new Error(`Last refresh failed: ${attempt.error ?? "unknown error"}`)} />}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={business.gbpTracking} disabled={!hasPlaceId || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
            Track monthly
          </label>
          <p className="text-xs text-muted-foreground">
            Est. {costLabel(overview.data.quote, billingMode)} per month.{" "}
            {business.gbpTracking && business.gbpNextRunAt ? `Next snapshot ${fmtDate(business.gbpNextRunAt)}.` : "Off by default: nothing is fetched until you turn this on or refresh."}
          </p>
        </div>

        {!latest ? (
          !running && <EmptyState title="No profile snapshot yet">Refresh now to take the first one. It becomes the baseline that later snapshots and alerts compare with.</EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Rating" value={<span className="inline-flex items-center gap-1.5">{fmtNum(latest.rating)} <Star className="size-5 fill-warning text-warning" /></span>} hint={change?.rating != null ? `${signed(change.rating, 1)} since ${fmtDate(change.since)}` : `as of ${fmtDate(latest.takenAt)}`} />
              <Stat label="Reviews" value={latest.reviewCount ?? "-"} hint={change?.reviewCount != null ? `${signed(change.reviewCount)} since ${fmtDate(change.since)}` : undefined} />
              <Stat label="Velocity" value={latest.velocity30d ?? "-"} hint="new reviews per 30 days" />
              <Stat label="Unanswered" value={latest.unansweredLast20 ?? "-"} hint="of the newest 20 reviews" />
            </div>
            <Sparkline history={history} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={latest.isClaimed ? "success" : "warning"}>{latest.isClaimed === null ? "Claim status unknown" : latest.isClaimed ? "Claimed" : "Not claimed"}</Badge>
              {latest.primaryCategory && <Badge>{latest.primaryCategory}</Badge>}
              {latest.additionalCategories.map((c) => <Badge key={c}>{c}</Badge>)}
              {latest.totalPhotos !== null && <span className="text-xs text-muted-foreground">{latest.totalPhotos} photos</span>}
              {latest.phone && <span className="text-xs text-muted-foreground">{latest.phone}</span>}
            </div>
          </>
        )}
      </div>
      {(latest || history.length > 0) && <Reviews businessId={businessId} />}
    </Card>
  );
}
