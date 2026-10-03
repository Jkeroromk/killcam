import Image from "next/image";
import Link from "next/link";
import type { Dict, Locale } from "@/lib/i18n";
import { ISSUES_URL, LATEST_URL, RELEASES_URL, REPO_URL, formatSize, type Release } from "@/lib/github";
import { Download, Github } from "./icons";

/** `path` is the current page without the language prefix ("" or "/changelog"). */
export function SiteNav({ d, lang, path }: { d: Dict; lang: Locale; path: string }) {
  const other: Locale = lang === "zh" ? "en" : "zh";
  const home = `/${lang}`;
  return (
    <header className="nav">
      <a className="skip" href="#main">
        {d.nav.skip}
      </a>
      <div className="nav-inner">
        <Link href={home} className="brand">
          <Image src="/brand.png" alt="" width={28} height={28} priority />
          <span>KillCam</span>
        </Link>
        <nav className="nav-links" aria-label="KillCam">
          <Link href={`${home}#features`}>{d.nav.features}</Link>
          <Link href={`${home}#install`}>{d.nav.install}</Link>
          <Link href={`${home}#faq`}>{d.nav.faq}</Link>
          <Link href={`${home}/changelog`} aria-current={path === "/changelog" ? "page" : undefined}>
            {d.nav.changelog}
          </Link>
        </nav>
        <div className="nav-end">
          <Link href={`/${other}${path}`} hrefLang={other === "zh" ? "zh-CN" : "en"} lang={other === "zh" ? "zh-CN" : "en"} aria-label={d.nav.otherLangLabel} className="lang">
            {d.nav.otherLang}
          </Link>
          <a href={REPO_URL} className="gh" aria-label="GitHub">
            <Github size={18} />
          </a>
        </div>
      </div>
    </header>
  );
}

export function DownloadButton({ d, release, big }: { d: Dict; release: Release | null; big?: boolean }) {
  const exe = release?.installer;
  return (
    <a className={big ? "btn-dl is-big" : "btn-dl"} href={exe ? exe.url : LATEST_URL}>
      <Download size={big ? 20 : 18} />
      <span className="btn-dl-text">{exe ? d.hero.download : d.hero.downloadFallback}</span>
      {exe && release && (
        <span className="btn-dl-meta">
          <span>v{release.version}</span>
          <span>{formatSize(exe.size)}</span>
        </span>
      )}
    </a>
  );
}

export function SiteFooter({ d, lang }: { d: Dict; lang: Locale }) {
  return (
    <footer className="foot">
      <div className="foot-inner">
        <Link href={`/${lang}`} className="brand is-small">
          <Image src="/brand.png" alt="" width={22} height={22} />
          <span>KillCam</span>
        </Link>
        <ul className="foot-links">
          <li>
            <a href={RELEASES_URL}>{d.footer.releases}</a>
          </li>
          <li>
            <a href={ISSUES_URL}>{d.footer.issues}</a>
          </li>
          <li>
            <a href={`${REPO_URL}/blob/main/LICENSE`}>{d.footer.license}</a>
          </li>
          <li>
            <a href={REPO_URL}>GitHub</a>
          </li>
        </ul>
        <p className="foot-note">{d.footer.by}</p>
      </div>
    </footer>
  );
}
