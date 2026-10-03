import { NextResponse, type NextRequest } from "next/server";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

// Sends "/" and any path without a language prefix to /zh or /en.
// Order: a remembered choice (cookie set by the language switch), then the
// browser's Accept-Language, then Chinese.
function pick(req: NextRequest): Locale {
  const saved = req.cookies.get("lang")?.value;
  if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  const accept = req.headers.get("accept-language")?.toLowerCase() ?? "";
  const first = accept.split(",")[0]?.trim() ?? "";
  if (first.startsWith("zh")) return "zh";
  if (first.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const current = LOCALES.find((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`));
  if (current) {
    // remember the language someone is reading, so "/" sends them back to it
    const res = NextResponse.next();
    if (req.cookies.get("lang")?.value !== current) {
      res.cookies.set("lang", current, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    }
    return res;
  }
  const url = req.nextUrl.clone();
  url.pathname = `/${pick(req)}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // skip Next internals, the icon and anything with a file extension
  matcher: ["/((?!_next|api|icon|.*\\..*).*)"],
};
