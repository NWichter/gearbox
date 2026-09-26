import { SiteFooter, SiteHeader } from "@/components/site-chrome";

// All pages with the tab bar; /final has its own chrome
export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
