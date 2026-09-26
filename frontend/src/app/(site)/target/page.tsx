import type { Metadata } from "next";
import { DashboardSwitch } from "@/components/dashboard-switch";

export const metadata: Metadata = { title: "Gearbox · dashboard target" };

// The target design is a static mockup (public/mockups), shown in a frame next to the live dashboard
export default function TargetDashboard() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DashboardSwitch />
        <a
          href="/mockups/gearbox-dashboard-target.html"
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground text-[12px] underline-offset-2 hover:underline"
        >
          Open in a new window ↗
        </a>
      </div>
      <iframe
        src="/mockups/gearbox-dashboard-target.html"
        title="Gearbox dashboard target (static mockup)"
        className="block h-[calc(100vh-10rem)] min-h-[640px] w-full rounded-lg border bg-[#07090c]"
      />
    </div>
  );
}
