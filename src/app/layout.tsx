import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ananta Universal Commercial Portal",
  description: "Internal commercial automation portal for Ananta Garments Ltd.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
