import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "数据分析平台",
  description: "企业数据分析平台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// 全站按请求 SSR：业务数据来自 InsForge，每次请求取最新值；
// 同时避免 build 阶段静态预渲染触发对后端的 fetch（build 容器内无后端会失败）。
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head>
        {/* DESIGN.md 指定：DM Sans via Google Fonts CDN <link>。
            不用 next/font/google —— Next 16 Turbopack 的 next/font 内部模块解析有 bug
            (@vercel/turbopack-next/internal/font/google/font not found) + gstatic 拉取失败致 500。 */}
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
