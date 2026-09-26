import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ChatWidget } from "@/components/chat-widget";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Gearbox",
  description: "Multi-sensor 802.11 monitoring for the factory floor",
};

// Header and footer live in (site)/layout.tsx and in /final
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground flex min-h-full flex-col text-sm">
        <TooltipProvider delay={150}>
          {children}
          <Toaster theme="light" position="bottom-center" />
          <ChatWidget />
        </TooltipProvider>
      </body>
    </html>
  );
}
