"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const VIEWS = [
  { href: "/", label: "Current dashboard" },
  { href: "/it", label: "IT view" },
  { href: "/target", label: "Target design (mockup)" },
];

// Switch between the live dashboard, the IT view and the static target design; all stay available
export function DashboardSwitch({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <div
      role="tablist"
      aria-label="Dashboard view"
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-8 items-center rounded-lg p-[3px] text-[12px]",
        className,
      )}
    >
      {VIEWS.map((v) => {
        const active = v.href === path;
        return (
          <Link
            key={v.href}
            href={v.href}
            role="tab"
            aria-selected={active}
            className={cn(
              "flex h-full items-center rounded-md px-3 whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground font-medium shadow-sm"
                : "hover:text-foreground",
            )}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
