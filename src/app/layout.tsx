import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import PWAInstall from "@/components/PWAInstall";

export const metadata: Metadata = {
  title: "EasyLearn (EL) | City Best International School Montessori",
  description: "Modern learning management system for CBISM - Nursery, Kindergarten, Primary & Junior High School",
  keywords: "school, education, LMS, learning, CBISM, EasyLearn",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "EasyLearn",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    title: "EasyLearn - CBISM",
    description: "Modern learning management system for City Best International School Montessori",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#2563eb",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Fredoka:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* PWA Meta Tags */}
        <meta name="application-name" content="EasyLearn" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="EasyLearn" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="msapplication-TileColor" content="#2563eb" />
        <meta name="msapplication-tap-highlight" content="no" />
        
        {/* Apple Touch Icons */}
        <link rel="apple-touch-icon" href="/icons/icon-152.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-152.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" sizes="167x167" href="/icons/icon-192.png" />
        
        {/* Favicon */}
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-96.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/icon-72.png" />
      </head>
      <body className="bg-white text-slate-900 antialiased">
        {children}
        <PWAInstall />
      </body>
    </html>
  );
}
