// Release data comes straight from GitHub Releases (the same place the app's
// updater reads latest.json from), cached for an hour by Next.
// Set GITHUB_TOKEN in Vercel if you ever hit the anonymous rate limit (60/h);
// a fine-grained token with no permissions at all is enough for a public repo.

export const REPO = "Jkeroromk/killcam";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_URL = `${REPO_URL}/releases/latest`;
export const ISSUES_URL = `${REPO_URL}/issues`;

export type Release = {
  tag: string;
  version: string;
  name: string;
  date: string; // ISO
  url: string;
  notes: string; // markdown, with the standard install reminder removed
  installer: { name: string; url: string; size: number } | null;
};

// The release workflow adds the same two-line install reminder to every
// release; it's covered by the install section, so the changelog drops it.
const BOILERPLATE = [/Windows 已保护你的电脑/, /会自己提示更新/];

type GhAsset = { name: string; size: number; browser_download_url: string };
type GhRelease = {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets: GhAsset[];
};

function toRelease(r: GhRelease): Release {
  const exe = r.assets.find((a) => /-setup\.exe$/i.test(a.name));
  const notes = (r.body ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !BOILERPLATE.some((re) => re.test(line)))
    .join("\n")
    .trim();
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/, ""),
    name: r.name ?? r.tag_name,
    date: r.published_at ?? r.created_at,
    url: r.html_url,
    notes,
    installer: exe ? { name: exe.name, url: exe.browser_download_url, size: exe.size } : null,
  };
}

/** Published releases, newest first. Returns [] if GitHub can't be reached,
 *  so pages still render with links to GitHub instead. */
export async function getReleases(): Promise<Release[]> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
      headers,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as GhRelease[];
    return data.filter((r) => !r.draft && !r.prerelease).map(toRelease);
  } catch {
    return [];
  }
}

export async function getLatest(): Promise<Release | null> {
  const all = await getReleases();
  return all[0] ?? null;
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function formatDate(iso: string, locale: "zh" | "en"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: locale === "zh" ? "long" : "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(d);
}
