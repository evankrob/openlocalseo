import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Building2, KeyRound, LayoutGrid, LogOut, MapPin, PlusCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { ApiError, get, post, setWorkspaceId } from "../lib/api";
import { cn } from "../lib/cn";
import type { Me } from "../lib/types";
import { Badge, Spinner } from "../components/ui";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => get<Me>("/me"),
    retry: (count, error) => !(error instanceof ApiError && [401, 403].includes(error.status)) && count < 2,
  });
}

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/trackers/new", label: "New grid scan", icon: PlusCircle },
  { to: "/businesses", label: "Businesses", icon: Building2 },
  { to: "/usage", label: "Usage & cost", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: KeyRound },
];

export function Shell() {
  const me = useMe();
  const qc = useQueryClient();
  const location = useLocation();

  if (me.isLoading) return <div className="grid h-full place-items-center"><Spinner className="size-6" /></div>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.error || !me.data) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Could not load your account</p>
          <p className="mt-1 text-sm text-muted-foreground">{me.error instanceof Error ? me.error.message : "Unknown error"}</p>
        </div>
      </div>
    );
  }
  const { config, workspace, workspaces, user } = me.data;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-sidebar-border bg-sidebar md:w-60 md:border-r md:border-b-0">
        <Link to="/" className="flex items-center gap-2 px-4 py-4 text-base font-semibold">
          <MapPin className="size-5 text-primary" /> OpenLocalSEO
        </Link>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cn("flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm hover:bg-foreground/5", isActive && "bg-foreground/10 font-medium")}
            >
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2 border-t border-sidebar-border p-3 text-xs md:block">
          {workspaces.length > 1 ? (
            <select
              className="w-full rounded-md border border-input bg-card px-2 py-1"
              value={workspace.id}
              aria-label="Workspace"
              onChange={(e) => { setWorkspaceId(e.target.value); qc.invalidateQueries(); }}
            >
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : (
            <div className="font-medium">{workspace.name}</div>
          )}
          <div className="truncate text-muted-foreground">{user.email} &middot; {workspace.role}</div>
          {config.authMode === "hosted" && (
            <button
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={async () => { await post("/auth/logout"); qc.clear(); window.location.assign("/login"); }}
            >
              <LogOut className="size-3" /> Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        {config.dataMode === "mock" && (
          <div className="no-print border-b border-warning/40 bg-warning/20 px-6 py-2 text-sm">
            <Badge tone="warning" className="mr-2">Mock data</Badge>
            Scans use simulated DataForSEO results and cost nothing. Set <code>DATAFORSEO_MODE=live</code> with your key to scan for real.
          </div>
        )}
        <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8"><Outlet context={me.data} /></div>
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
