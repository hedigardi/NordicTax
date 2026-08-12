import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NordicTax Dashboard",
  description: "CSV to Norwegian crypto tax summary with FIFO",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
