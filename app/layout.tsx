import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AXNetCC v2 | Security-Aware Evidence Acquisition",
  description: "부서별 Agent와 데이터 경계를 유지하는 Security-Aware Evidence Acquisition 연구 플랫폼",
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
