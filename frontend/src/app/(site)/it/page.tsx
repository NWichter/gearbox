import type { Metadata } from "next";
import { ItConsolePage } from "@/components/it-console";

export const metadata: Metadata = { title: "Gearbox · IT view" };

// Alternative dashboard for IT: incidents by owning team, where each connection breaks,
// the radios and BSSIDs involved, and ticket-ready evidence. Selectable next to the main view.
export default function ItView() {
  return <ItConsolePage />;
}
