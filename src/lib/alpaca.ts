import type { Bar } from "../analysis/signals";
import type { Env } from "../model/config-env";
import { etParts } from "./time";

const DATA_URL = "https://data.alpaca.markets";

export type Feed = "sip" | "iex";

type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number };

function headers(env: Env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
    accept: "application/json",
  };
}

class AlpacaError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Alpaca error ${status}: ${body.slice(0, 300)}`);
  }
}

async function getJson<T>(url: URL, env: Env): Promise<T> {
  const res = await fetch(url.toString(), { headers: headers(env) });
  if (!res.ok) throw new AlpacaError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export type DailyBarsResult = {
  bars: Record<string, Bar[]>;
  feed: Feed;
  /** เวลาของข้อมูลล่าสุด (SIP ฟรีต้องดีเลย์ 15 นาที) */
  asOf: Date;
};

/**
 * แท่งรายวันย้อนหลัง ~400 วัน (พอสำหรับ 52w high/low และ SMA200)
 * แท่งสุดท้ายคือของวันนี้ (ยังไม่ปิด) ถ้าตลาดเปิดอยู่
 *
 * SIP = ข้อมูลรวมทุกตลาด (แม่นกว่า IEX ที่มีแค่ ~2-3% ของวอลุ่ม)
 * บัญชีฟรีขอ SIP ได้ถ้าข้อมูลเก่ากว่า 15 นาที จึงตั้ง end = now - 16 นาที
 */
export async function fetchDailyBars(
  symbols: string[],
  env: Env,
  feed: Feed,
  now: Date,
  days = 400,
): Promise<DailyBarsResult> {
  const asOf = feed === "sip" ? new Date(now.getTime() - 16 * 60_000) : now;
  const url = new URL(`${DATA_URL}/v2/stocks/bars`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10));
  if (feed === "sip") url.searchParams.set("end", asOf.toISOString());
  url.searchParams.set("adjustment", "all");
  url.searchParams.set("feed", feed);
  url.searchParams.set("limit", "10000");

  const out: Record<string, Bar[]> = {};
  try {
    let pageToken: string | null = null;
    do {
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const data: { bars?: Record<string, RawBar[]>; next_page_token?: string | null } =
        await getJson(url, env);
      for (const [sym, raw] of Object.entries(data.bars ?? {})) {
        (out[sym] ??= []).push(
          ...raw.map((b) => ({
            date: etParts(new Date(b.t)).date,
            o: b.o,
            h: b.h,
            l: b.l,
            c: b.c,
            v: b.v,
          })),
        );
      }
      pageToken = data.next_page_token ?? null;
    } while (pageToken);
  } catch (err) {
    if (feed === "sip" && err instanceof AlpacaError && err.status === 403) {
      console.warn("[alpaca] SIP not permitted, falling back to IEX");
      return fetchDailyBars(symbols, env, "iex", now, days);
    }
    throw err;
  }

  return { bars: out, feed, asOf };
}

export type NewsItem = { headline: string; summary: string; url: string; createdAt: string; source: string };

export async function fetchNews(
  symbols: string[],
  env: Env,
  since: Date,
  perSymbol = 2,
  until?: Date,
): Promise<Record<string, NewsItem[]>> {
  const out: Record<string, NewsItem[]> = {};
  if (!symbols.length) return out;

  const url = new URL(`${DATA_URL}/v1beta1/news`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("start", since.toISOString());
  if (until) url.searchParams.set("end", until.toISOString());
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", "50");
  url.searchParams.set("exclude_contentless", "false");

  const data = await getJson<{
    news?: Array<{ headline: string; summary?: string; url: string; created_at: string; source: string; symbols: string[] }>;
  }>(url, env);

  const wanted = new Set(symbols);
  for (const n of data.news ?? []) {
    // ข่าวที่แท็กหลายสิบตัวมักเป็นข่าวภาพรวม ไม่ใช่ข่าวของหุ้นตัวนั้น
    if (n.symbols.length > 5) continue;
    for (const s of n.symbols) {
      if (!wanted.has(s)) continue;
      const list = (out[s] ??= []);
      if (list.length < perSymbol) {
        list.push({
          headline: n.headline,
          summary: (n.summary ?? "").replace(/\s+/g, " ").trim(),
          url: n.url,
          createdAt: n.created_at,
          source: n.source,
        });
      }
    }
  }
  return out;
}

export type RawAlpacaNews = {
  id: number;
  headline: string;
  summary: string;
  url: string;
  createdAt: string;
  source: string;
  symbols: string[];
};

/** ข่าวทั้งหมดของ symbols ตั้งแต่ since (ใหม่สุดก่อน) — ใช้กับ News Radar */
export async function fetchNewsSince(
  symbols: string[],
  env: Env,
  since: Date,
  maxItems = 100,
): Promise<RawAlpacaNews[]> {
  if (!symbols.length) return [];
  const url = new URL(`${DATA_URL}/v1beta1/news`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("start", since.toISOString());
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", "50");
  url.searchParams.set("exclude_contentless", "false");

  const out: RawAlpacaNews[] = [];
  let pageToken: string | null = null;
  do {
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data: {
      news?: Array<{ id: number; headline: string; summary?: string; url: string; created_at: string; source: string; symbols: string[] }>;
      next_page_token?: string | null;
    } = await getJson(url, env);
    for (const n of data.news ?? []) {
      out.push({
        id: n.id,
        headline: n.headline,
        summary: (n.summary ?? "").replace(/\s+/g, " ").trim(),
        url: n.url,
        createdAt: n.created_at,
        source: n.source,
        symbols: n.symbols,
      });
    }
    pageToken = data.next_page_token ?? null;
  } while (pageToken && out.length < maxItems);
  return out.slice(0, maxItems);
}

export type Snapshot = { price: number; prevClose: number | null; changePct: number | null; at: string };

/**
 * ราคาล่าสุด (IEX real-time — บัญชีฟรีขอ SIP ล่าสุดไม่ได้)
 * ใช้เป็นบริบทว่าข่าว "ถูกสะท้อนในราคาไปแล้วหรือยัง" ไม่ได้ใช้คำนวณสัญญาณ
 */
export async function fetchSnapshots(symbols: string[], env: Env): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  if (!symbols.length) return out;
  const url = new URL(`${DATA_URL}/v2/stocks/snapshots`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("feed", "iex");
  const data = await getJson<
    Record<string, { latestTrade?: { p: number; t: string }; dailyBar?: { c: number; t: string }; prevDailyBar?: { c: number } } | null>
  >(url, env);
  for (const [sym, s] of Object.entries(data)) {
    const price = s?.latestTrade?.p ?? s?.dailyBar?.c;
    if (!s || price == null) continue;
    const prevClose = s.prevDailyBar?.c ?? null;
    out[sym] = {
      price,
      prevClose,
      changePct: prevClose ? (price / prevClose - 1) * 100 : null,
      at: s.latestTrade?.t ?? s.dailyBar?.t ?? "",
    };
  }
  return out;
}
