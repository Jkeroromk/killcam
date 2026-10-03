import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDict, isLocale } from "@/lib/i18n";
import { RELEASES_URL, formatDate, formatSize, getReleases } from "@/lib/github";
import { SiteFooter, SiteNav } from "@/components/Chrome";
import { Notes } from "@/components/Notes";
import { Download } from "@/components/icons";
import { ScrollReveal } from "@/components/ScrollReveal";

export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = getDict(lang);
  return {
    title: d.meta.changelogTitle,
    description: d.changelog.intro,
    alternates: { canonical: `/${lang}/changelog`, languages: { "zh-CN": "/zh/changelog", en: "/en/changelog" } },
  };
}

export default async function Changelog({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = getDict(lang);
  const releases = await getReleases();

  return (
    <>
      <SiteNav d={d} lang={lang} path="/changelog" />
      <main id="main" className="changelog">
        <div className="wrap is-narrow">
          <header className="cl-head">
            <h1>{d.changelog.title}</h1>
            <p>{d.changelog.intro}</p>
          </header>

          {releases.length === 0 ? (
            <p className="cl-empty">
              {d.changelog.unavailable} <a href={RELEASES_URL}>{d.changelog.allOnGithub}</a>
            </p>
          ) : (
            <ol className="cl-list">
              {releases.map((r, i) => (
                <li key={r.tag} className={i === 0 ? "cl-item is-latest" : "cl-item"} data-reveal>
                  <div className="cl-rail" aria-hidden="true" />
                  <div className="cl-body">
                    <h2 className="cl-ver">
                      <a href={r.url}>v{r.version}</a>
                      {i === 0 && <span className="cl-badge">{d.changelog.latest}</span>}
                    </h2>
                    <p className="cl-date">
                      <time dateTime={r.date}>{formatDate(r.date, lang)}</time>
                    </p>
                    {r.notes ? <Notes md={r.notes} /> : <p className="cl-none">{d.changelog.noNotes}</p>}
                    {r.installer && (
                      <a className="cl-dl" href={r.installer.url}>
                        <Download size={15} />
                        {d.changelog.download}
                        <span className="cl-size">{formatSize(r.installer.size)}</span>
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          <p className="cl-foot">
            <a href={RELEASES_URL}>{d.changelog.allOnGithub}</a>
            <Link href={`/${lang}`}>{d.changelog.back}</Link>
          </p>
        </div>
      </main>
      <SiteFooter d={d} lang={lang} />
      <ScrollReveal />
    </>
  );
}
