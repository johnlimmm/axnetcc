import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MNC FLOW | 분산 AI Agent 거버넌스",
  description: "KOREN 기반 분산 AI Agent 협력 거버넌스 플랫폼 시연",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link rel="stylesheet" href="/site.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
