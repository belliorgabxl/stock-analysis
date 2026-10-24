import { fetchNewsSince } from "../lib/alpaca";
import type { Env } from "../model/config-env";

export type NewsKind = "company" | "filing" | "macro";

/** ข่าว/เอกสารจากทุกแหล่ง แปลงเป็นรูปเดียวกันก่อนส่งให้ AI */
export type RawItem = {
  /** กันซ้ำข้ามรอบ: "a:<alpaca id>" | "s:<accession no>" | "r:<hash ของลิงก์>" */
  key: string;
  kind: NewsKind;
  symbols: string[];
  source: string;
  headline: string;
  summary: string;
  url: string;
  publishedAt: string; // ISO
};

// ---------- Alpaca (Benzinga ฯลฯ) ----------

export async function alpacaItems(symbols: string[], env: Env, since: Date): Promise<RawItem[]> {
  const news = await fetchNewsSince(symbols, env, since);
  const out: RawItem[] = [];
  for (const n of news) {
    // ข่าวที่แท็กหลายสิบตัวมักเป็นข่าวสรุปตลาด ไม่ใช่ข่าวของหุ้นตัวนั้น
    if (n.symbols.length > 5) continue;
    out.push({
      key: `a:${n.id}`,
      kind: "company",
      symbols: n.symbols,
      source: n.source,
      headline: n.headline,
      summary: n.summary.slice(0, 400),
      url: n.url,
      publishedAt: n.createdAt,
    });
  }
  return out;
}

// ---------- SEC EDGAR ----------

/**
 * แบบฟอร์มที่มักกระทบราคา (ไม่เอา Form 4 เพราะ feed ไม่บอกว่าซื้อหรือขาย ส่วนใหญ่เป็นแค่ noise)
 * - 8-K: เหตุการณ์สำคัญ (งบ, ดีล, ผู้บริหารลาออก, ถูกเตือนเรื่อง delisting ฯลฯ)
 * - S-1/S-3/424B: เตรียมออกหุ้นเพิ่ม (dilution) — หุ้นเล็กโดนบ่อยมาก
 * - NT 10-Q/10-K: ส่งงบไม่ทัน (สัญญาณลบ)
 * - SC 13D/13G: ผู้ถือหุ้นใหญ่เข้า/ออก
 * ไม่เอา 144 (คนในแจ้งจะขาย) เพราะยื่นถี่มาก บางวันตัวเดียวหลายฉบับ
 */
const FILING_FORMS = /^(8-K|6-K|10-Q|10-K|S-1|S-3|F-3|424B\d|NT 10-[QK]|SC 13[DG]|SCHEDULE 13[DG]|25-NSE|15-12[BG])/;

function xmlText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * เอกสารล่าสุดที่ยื่น SEC ของหุ้นแต่ละตัว (EDGAR รับ ticker แทน CIK ได้)
 * SEC บังคับให้ใส่ User-Agent ที่มีชื่อ + อีเมลติดต่อ ไม่งั้นโดนบล็อก
 */
export async function secItems(symbols: string[], userAgent: string, since: Date): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
      url.searchParams.set("action", "getcompany");
      url.searchParams.set("CIK", symbol);
      url.searchParams.set("type", "");
      url.searchParams.set("dateb", "");
      url.searchParams.set("owner", "include");
      url.searchParams.set("count", "15");
      url.searchParams.set("output", "atom");
      const res = await fetch(url.toString(), { headers: { "user-agent": userAgent, accept: "application/atom+xml" } });
      if (!res.ok) throw new Error(`SEC ${symbol}: ${res.status}`);
      return { symbol, xml: await res.text() };
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[sec]", String(r.reason));
      continue;
    }
    const { symbol, xml } = r.value;
    const company = xmlText(xml, "conformed-name");
    for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const form = xmlText(entry, "filing-type");
      if (!FILING_FORMS.test(form)) continue;
      const updated = xmlText(entry, "updated");
      if (!updated || new Date(updated) < since) continue;
      const accession = xmlText(entry, "accession-number");
      // summary ของ 8-K มีรายการ Item เช่น "Item 2.02: Results of Operations..."
      const items = stripTags(xmlText(entry, "summary").replace(/<br\s*\/?>/gi, " | "))
        .split(" | ")
        .slice(1)
        .join(" | ");
      out.push({
        key: `s:${accession}`,
        kind: "filing",
        symbols: [symbol],
        source: "SEC EDGAR",
        headline: `${company || symbol} ยื่น ${form} (${xmlText(entry, "form-name")})`,
        summary: items.slice(0, 500),
        url: entry.match(/<link href="([^"]+)"/)?.[1] ?? xmlText(entry, "filing-href"),
        publishedAt: new Date(updated).toISOString(),
      });
    }
  }
  return out;
}

// ---------- RSS ข่าวมหภาค ----------

export const DEFAULT_RSS_FEEDS = [
  "https://www.cnbc.com/id/15839069/device/rss/rss.html", // CNBC Investing
  "https://www.cnbc.com/id/19854910/device/rss/rss.html", // CNBC Tech
  "https://www.cnbc.com/id/20910258/device/rss/rss.html", // CNBC Economy
  "https://www.cnbc.com/id/10000664/device/rss/rss.html", // CNBC Finance
  "https://feeds.content.dowjones.io/public/rss/mw_bulletins", // MarketWatch Bulletins
];

function hash(s: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export async function rssItems(feeds: string[], since: Date, perFeed = 15): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await fetch(feed, { headers: { "user-agent": "Mozilla/5.0 (stock-alert-worker)", accept: "application/rss+xml, application/xml" } });
      if (!res.ok) throw new Error(`RSS ${feed}: ${res.status}`);
      return { feed, xml: await res.text() };
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[rss]", String(r.reason));
      continue;
    }
    const { feed, xml } = r.value;
    const channel = xmlText(xml.split("<item")[0], "title");
    const source = `${new URL(feed).hostname.replace(/^(www|feeds)\./, "").split(".")[0].toUpperCase()}${channel ? ` ${channel.replace(/^MarketWatch\.com - /, "")}` : ""}`;
    let n = 0;
    for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
      if (n >= perFeed) break;
      const link = xmlText(item, "link");
      const title = stripTags(xmlText(item, "title"));
      const pub = xmlText(item, "pubDate");
      if (!title || !link) continue;
      const published = pub ? new Date(pub) : null;
      if (!published || Number.isNaN(published.getTime()) || published < since) continue;
      n++;
      out.push({
        key: `r:${hash(link.split("?")[0])}`,
        kind: "macro",
        symbols: [],
        source,
        headline: title,
        summary: stripTags(xmlText(item, "description")).slice(0, 300),
        url: link,
        publishedAt: published.toISOString(),
      });
    }
  }
  return out;
}
