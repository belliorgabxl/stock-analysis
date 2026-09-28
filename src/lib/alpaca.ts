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

export type NewsItem = { headline: string; url: string; createdAt: string; source: string };

export async function fetchNews(
  symbols: string[],
  env: Env,
  since: Date,
  perSymbol = 2,
): Promise<Record<string, NewsItem[]>> {
  const out: Record<string, NewsItem[]> = {};
  if (!symbols.length) return out;

  const url = new URL(`${DATA_URL}/v1beta1/news`);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("start", since.toISOString());
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", "50");
  url.searchParams.set("exclude_contentless", "false");

  const data = await getJson<{
    news?: Array<{ headline: string; url: string; created_at: string; source: string; symbols: string[] }>;
  }>(url, env);

  const wanted = new Set(symbols);
  for (const n of data.news ?? []) {
    // ข่าวที่แท็กหลายสิบตัวมักเป็นข่าวภาพรวม ไม่ใช่ข่าวของหุ้นตัวนั้น
    if (n.symbols.length > 5) continue;
    for (const s of n.symbols) {
      if (!wanted.has(s)) continue;
      const list = (out[s] ??= []);
      if (list.length < perSymbol) {
        list.push({ headline: n.headline, url: n.url, createdAt: n.created_at, source: n.source });
      }
    }
  }
  return out;
}
