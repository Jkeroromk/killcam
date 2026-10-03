import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Barlow, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import { LOCALES, getDict, isLocale } from "@/lib/i18n";
import "../globals.css";

const display = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--f-display", display: "swap" });
const body = Barlow({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--f-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--f-mono", display: "swap" });

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export const viewport: Viewport = {
  themeColor: "#161a14",
  colorScheme: "dark",
};

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://killcam.vercel.app";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = getDict(lang);
  return {
    metadataBase: new URL(SITE),
    title: { default: d.meta.title, template: `%s | KillCam` },
    description: d.meta.description,
    alternates: {
      canonical: `/${lang}`,
      languages: { "zh-CN": "/zh", en: "/en" },
    },
    openGraph: {
      type: "website",
      siteName: "KillCam",
      title: d.meta.title,
      description: d.meta.description,
      locale: lang === "zh" ? "zh_CN" : "en_US",
      images: [{ url: "/screens/match.jpg", width: 1600, height: 1000 }],
    },
    twitter: { card: "summary_large_image", title: d.meta.title, description: d.meta.description, images: ["/screens/match.jpg"] },
  };
}

export default async function RootLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return (
    <html lang={lang === "zh" ? "zh-CN" : "en"} className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
