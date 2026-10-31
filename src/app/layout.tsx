import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ananta Universal Commercial Portal",
  description: "Internal commercial automation portal for Ananta Garments Ltd.",
};

// Apply the saved theme before first paint so there is no light→dark flash.
// Default is light (no saved pref) so the current appearance is unchanged.
const themeScript = `try{if(localStorage.getItem('ucp-theme')==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
