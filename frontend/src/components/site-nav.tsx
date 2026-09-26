"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard", short: "Dashboard" },
  { href: "/floor", label: "Shop floor", short: "Floor" },
  { href: "/engineering", label: "Engineering", short: "Engineering" },
  { href: "/report", label: "Shift report", short: "Report" },
  { href: "/architecture", label: "Scale design", short: "Scale" },
];

export function SiteNav() {
  const path = usePathname();
  return (
    <nav className="-mr-4 flex min-w-0 items-stretch gap-0.5 self-stretch overflow-x-auto pr-4 text-[13px] [scrollbar-width:none] sm:mr-0 sm:pr-0">
      {LINKS.map((l) => {
        const active =
          l.href === "/"
            ? path === "/" || path === "/target" || path === "/it"
            : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex shrink-0 items-center px-2 whitespace-nowrap transition-colors sm:px-3",
              active
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="sm:hidden">{l.short}</span>
            <span className="hidden sm:inline">{l.label}</span>
            {active && (
              <span className="bg-foreground absolute inset-x-2 bottom-0 h-0.5 sm:inset-x-3" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
