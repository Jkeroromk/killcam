import Image from "next/image";
import { notFound } from "next/navigation";
import { getDict, isLocale } from "@/lib/i18n";
import { ISSUES_URL, REPO_URL, getLatest } from "@/lib/github";
import { DownloadButton, SiteFooter, SiteNav } from "@/components/Chrome";
import { MatchTimeline } from "@/components/MatchTimeline";
import { SmartScreen } from "@/components/SmartScreen";
import { ChevronDown, Github } from "@/components/icons";

export const revalidate = 3600;

export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = getDict(lang);
  const latest = await getLatest();

  return (
    <>
      <SiteNav d={d} lang={lang} path="" />

      <main id="main">
        <section className="hero">
          <div className="wrap">
            <div className="hero-copy">
              <h1 className="hero-title">
                <span>{d.hero.titleA}</span>
                <span>{d.hero.titleB}</span>
              </h1>
              <p className="hero-sub">{d.hero.sub}</p>
              <div className="hero-actions">
                <DownloadButton d={d} release={latest} big />
                <a className="btn-ghost" href={REPO_URL}>
                  <Github size={18} />
                  {d.hero.source}
                </a>
              </div>
              <p className="hero-free">{d.hero.free}</p>
            </div>
            <MatchTimeline t={d.timeline} locale={lang} />
          </div>
        </section>

        <section className="shots" aria-label="KillCam">
          <div className="wrap shots-grid">
            <figure className="shot shot-main">
              <Image src="/screens/match.jpg" alt={d.shots.match} width={1600} height={1000} sizes="(max-width: 900px) 100vw, 860px" priority />
              <figcaption>{d.shots.match}</figcaption>
            </figure>
            <div className="shots-side">
              <figure className="shot">
                <Image src="/screens/home.jpg" alt={d.shots.home} width={1600} height={1000} sizes="(max-width: 900px) 100vw, 380px" />
                <figcaption>{d.shots.home}</figcaption>
              </figure>
              <figure className="shot">
                <Image src="/screens/mini.png" alt={d.shots.mini} width={600} height={216} sizes="(max-width: 900px) 100vw, 380px" />
                <figcaption>{d.shots.mini}</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section id="features" className="block">
          <div className="wrap">
            <header className="block-head">
              <h2>{d.features.title}</h2>
              <p>{d.features.intro}</p>
            </header>
            <ul className="features">
              {d.features.items.map((f) => (
                <li key={f.title}>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="install" className="block is-panel">
          <div className="wrap install">
            <div className="install-steps">
              <h2>{d.install.title}</h2>
              <ol className="steps">
                {d.install.steps.map((s, i) => (
                  <li key={s.title}>
                    <span className="step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div>
                      <h3>{s.title}</h3>
                      <p>{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="install-after">{d.install.after}</p>
            </div>
            <div className="install-side">
              <SmartScreen s={d.install.smart} file={latest?.installer?.name} />
              <h3 className="reqs-title">{d.reqs.title}</h3>
              <dl className="reqs">
                {d.reqs.rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section className="block is-privacy">
          <div className="wrap privacy">
            <h2>{d.privacy.title}</h2>
            <ul>
              {d.privacy.items.map((p) => (
                <li key={p.title}>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="faq" className="block">
          <div className="wrap faq">
            <h2>{d.faq.title}</h2>
            <div className="faq-list">
              {d.faq.items.map((f) => (
                <details key={f.q}>
                  <summary>
                    <span>{f.q}</span>
                    <ChevronDown size={18} />
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
              <p className="faq-more">
                <a href={ISSUES_URL}>{d.faq.more}</a>
              </p>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="wrap cta-inner">
            <div>
              <h2>{d.cta.title}</h2>
              <p>{d.cta.sub}</p>
            </div>
            <DownloadButton d={d} release={latest} big />
          </div>
        </section>
      </main>

      <SiteFooter d={d} lang={lang} />
    </>
  );
}
