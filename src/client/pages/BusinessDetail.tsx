import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { get } from "../lib/api";
import type { Me } from "../lib/types";
import { GbpPanel } from "../components/GbpPanel";
import { Button, ErrorNote, Spinner } from "../components/ui";
import { PageHeader } from "./shell";

type Business = { id: string; name: string; address: string | null; category: string | null };

export function BusinessDetail() {
  const { id = "" } = useParams();
  const me = useOutletContext<Me>();
  const list = useQuery({ queryKey: ["businesses"], queryFn: () => get<Business[]>("/businesses") });
  if (list.isLoading) return <Spinner />;
  const business = list.data?.find((b) => b.id === id);
  if (!business) return <ErrorNote error={list.error ?? new Error("Business not found")} />;
  return (
    <>
      <PageHeader
        title={business.name}
        description={[business.category, business.address].filter(Boolean).join(" · ") || undefined}
        actions={<Link to="/businesses"><Button variant="outline" size="sm">All businesses</Button></Link>}
      />
      <GbpPanel businessId={business.id} billingMode={me.config.billingMode} />
    </>
  );
}
