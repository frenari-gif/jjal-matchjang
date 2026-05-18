import type { Metadata, Viewport } from "next";
import { SoundProvider } from "../components/SoundProvider";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "짤맞짱",
    template: "%s | 짤맞짱"
  },
  description: "PC 웹브라우저에서 즐기는 실시간 멀티 짤 제목 맞짱 게임",
  applicationName: "짤맞짱",
  openGraph: {
    title: "짤맞짱",
    description: "이미지를 보고 가장 웃긴 제목을 제출하고 투표하는 실시간 멀티 웹게임",
    url: siteUrl,
    siteName: "짤맞짱",
    type: "website",
    images: [
      {
        url: "/logo.png",
        width: 1200,
        height: 630,
        alt: "짤맞짱 로고"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "짤맞짱",
    description: "이미지를 보고 가장 웃긴 제목을 제출하고 투표하는 실시간 멀티 웹게임",
    images: ["/logo.png"]
  },
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" }
    ],
    apple: "/apple-touch-icon.png"
  },
  robots: {
    index: true,
    follow: true
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#10131a"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <SoundProvider>{children}</SoundProvider>
      </body>
    </html>
  );
}
