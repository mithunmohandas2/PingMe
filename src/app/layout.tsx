import type { Metadata, Viewport } from "next";
import "./fonts.css";
import "./globals.css";
import "./appearance.css";
import "./profile.css";
import AppControls from "@/components/AppControls";
export const metadata: Metadata = {
  title: "Ping Me Messenger",
  description: "Private chats with people who matter",
  applicationName: "Ping Me",
  appleWebApp: { capable: true, title: "Ping Me" },
};
export const viewport: Viewport = {
  themeColor: "#2563eb",
  width: "device-width",
  initialScale: 1,
};
const themeScript = `(function(){try{var t=localStorage.getItem('pingme-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){}})()`;
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link
          rel="icon"
          href="/icon.svg?v=3"
          type="image/svg+xml"
          sizes="any"
        />
        <link rel="icon" href="/favicon.ico?v=3" sizes="16x16 32x32 48x48" />
        <link
          rel="apple-touch-icon"
          href="/icons/apple-touch-icon.png?v=3"
          sizes="180x180"
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Ping Me" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppControls />
        {children}
      </body>
    </html>
  );
}
