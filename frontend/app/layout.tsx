import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogTidy — Universal Log Compression",
  description:
    "Paste or upload raw logs (Sitecore, Azure, IIS, JSON-lines, any format) and get a compressed, structured summary. No AI, no cloud, no config.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-zinc-950">{children}</body>
    </html>
  );
}
