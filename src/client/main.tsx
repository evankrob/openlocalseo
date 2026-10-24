import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles/app.css";
import { AlertsPage } from "./pages/Alerts";
import { AuthPage } from "./pages/Auth";
import { BusinessDetail } from "./pages/BusinessDetail";
import { Businesses } from "./pages/Businesses";
import { Dashboard } from "./pages/Dashboard";
import { PublicReport } from "./pages/PublicReport";
import { ScanPage } from "./pages/ScanPage";
import { Settings } from "./pages/Settings";
import { Shell } from "./pages/shell";
import { TrackerDetail } from "./pages/TrackerDetail";
import { TrackerNew } from "./pages/TrackerNew";
import { UsagePage } from "./pages/Usage";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/r/:token" element={<PublicReport />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="trackers/new" element={<TrackerNew />} />
            <Route path="trackers/:id" element={<TrackerDetail />} />
            <Route path="scans/:id" element={<ScanPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="businesses" element={<Businesses />} />
            <Route path="businesses/:id" element={<BusinessDetail />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
