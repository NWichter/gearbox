import Link from "next/link";
import { Logo } from "@/components/logo";
import { SiteNav } from "@/components/site-nav";
import { TeslaBadge, TeslaMark } from "@/components/tesla-mark";
import { cn } from "@/lib/utils";

// Top bar with logo, page tabs (optional) and the Tesla badge
export function SiteHeader({
  nav = true,
  sticky = true,
  home = "/",
}: {
  nav?: boolean;
  sticky?: boolean;
  home?: string;
}) {
  return (
    <header
      className={cn(
        "bg-background/95 z-40 border-b backdrop-blur",
        sticky && "sticky top-0",
      )}
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-8">
        <Link href={home} aria-label="Gearbox home" className="shrink-0">
          <Logo />
        </Link>
        {nav && <SiteNav />}
        <span className="ml-auto hidden shrink-0 lg:block">
          <TeslaBadge />
        </span>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto flex max-w-[1440px] flex-col gap-2 px-4 pt-5 pb-20 text-[11px] sm:px-8 sm:pr-40 sm:pb-6">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="inline-flex items-center gap-2">
            <TeslaMark className="text-foreground size-3.5" />
            Built for the Tesla Airframe challenge · BMT 2026
          </span>
          <span>Gearbox reads frame headers only. It stores no payload.</span>
        </div>
        <p className="text-muted-foreground/80">
          Tesla and the Tesla logo are trademarks of Tesla, Inc. Gearbox is not
          a Tesla product.
        </p>
      </div>
    </footer>
  );
}
