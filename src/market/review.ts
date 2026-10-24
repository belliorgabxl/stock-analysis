import type { Bar } from "../analysis/signals";
import type { AiLogEntry } from "../alerts/state";
import { etParts } from "../lib/time";
import type { NewsLogEntry } from "../news/state";

/**
 * วัดความแม่นของ AI ย้อนหลัง: เทียบสิ่งที่ AI บอก กับราคาที่เกิดขึ้นจริงหลังจากนั้น 1 และ 5 วันทำการ
 * ไว้ตัดสินใจว่าควรเชื่อ ★ / impact ของ AI แค่ไหน (เช่น ก่อนตั้ง AI_MIN_IMPORTANCE)
 */
export type BucketStats = {
  n: number;
  /** ขนาดการขยับเฉลี่ย (ไม่สนทิศ) 5 วันหลังจากนั้น */
  avgAbsMove5: number | null;
  /** % ครั้งที่ราคาไปทางเดียวกับที่คาด/ทางเดียวกับวันที่เตือน */
  hitRate1: number | null;
  hitRate5: number | null;
  /** ผลตอบแทนเฉลี่ยถ้าทำตามทิศที่ AI บอก (หน่วย %) */
  avgDirectional5: number | null;
};

export type ReviewResult = {
  windowDays: number;
  priceAlerts: Record<string, BucketStats>;
  news: Record<string, BucketStats>;
  pending: number;
};

/**
 * ผลตอบแทน (%) จาก entryPrice ไปถึงราคาปิดของวันทำการที่ N หลัง entryDate
 * sameDay = true: นับราคาปิดของ entryDate เป็นวันที่ 1 (ข่าวที่ออกก่อนตลาดปิด)
 */
export function forwardReturn(bars: Bar[], entryDate: string, entryPrice: number, n: number, sameDay = false): number | null {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (sameDay ? bars[i].date < entryDate : bars[i].date <= entryDate) idx = i;
    else break;
  }
  const target = bars[idx + n];
  if (idx < 0 || !target || entryPrice <= 0) return null;
  return (target.c / entryPrice - 1) * 100;
}

type Sample = { dir: 1 | -1; r1: number | null; r5: number | null };

function stats(samples: Sample[]): BucketStats {
  const with1 = samples.filter((s) => s.r1 != null);
  const with5 = samples.filter((s) => s.r5 != null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rate = (xs: Sample[], key: "r1" | "r5") =>
    xs.length ? (xs.filter((s) => Math.sign(s[key]!) === s.dir).length / xs.length) * 100 : null;
  return {
    n: samples.length,
    avgAbsMove5: mean(with5.map((s) => Math.abs(s.r5!))),
    hitRate1: rate(with1, "r1"),
    hitRate5: rate(with5, "r5"),
    avgDirectional5: mean(with5.map((s) => s.r5! * s.dir)),
  };
}

export function reviewAccuracy(
  aiLog: AiLogEntry[],
  newsLog: NewsLogEntry[],
  bars: Record<string, Bar[]>,
  today: string,
  windowDays = 90,
): ReviewResult {
  const from = new Date(Date.parse(today) - windowDays * 86_400_000).toISOString().slice(0, 10);
  let pending = 0;

  // การแจ้งเตือนราคา: แบ่งตาม ★ ที่ AI ให้ วัดว่าราคา "ไปต่อ" ทางเดียวกับวันที่เตือนไหม
  const priceBuckets: Record<string, Sample[]> = { "★1-2": [], "★3": [], "★4-5": [] };
  for (const e of aiLog) {
    if (e.date < from || e.date >= today || e.changePct === 0) continue;
    const b = bars[e.symbol];
    if (!b) continue;
    const r1 = forwardReturn(b, e.date, e.price, 1);
    if (r1 == null) {
      pending++;
      continue;
    }
    const key = e.importance >= 4 ? "★4-5" : e.importance === 3 ? "★3" : "★1-2";
    priceBuckets[key].push({ dir: e.changePct > 0 ? 1 : -1, r1, r5: forwardReturn(b, e.date, e.price, 5) });
  }

  // ข่าว: วัดว่าราคาไปตามทิศที่ AI ประเมินไหม (ไม่นับข่าว mixed/neutral)
  const newsBuckets: Record<string, Sample[]> = { "แจ้งเตือนแล้ว": [], "impact 3 (ไม่ได้เตือน)": [] };
  for (const e of newsLog) {
    if (e.date < from || e.date >= today || e.price == null || !e.priceSymbol) continue;
    if (e.direction !== "bullish" && e.direction !== "bearish") continue;
    const b = bars[e.priceSymbol];
    if (!b) continue;
    const et = etParts(new Date(e.at));
    const sameDay = et.weekday >= 1 && et.weekday <= 5 && et.hour < 16;
    const r1 = forwardReturn(b, e.date, e.price, 1, sameDay);
    if (r1 == null) {
      pending++;
      continue;
    }
    const key = e.alerted ? "แจ้งเตือนแล้ว" : "impact 3 (ไม่ได้เตือน)";
    newsBuckets[key].push({ dir: e.direction === "bullish" ? 1 : -1, r1, r5: forwardReturn(b, e.date, e.price, 5, sameDay) });
  }

  const map = (b: Record<string, Sample[]>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, stats(v)]));
  return { windowDays, priceAlerts: map(priceBuckets), news: map(newsBuckets), pending };
}

/** symbol ที่ต้องดึงราคามาใช้ในการ review */
export function reviewSymbols(aiLog: AiLogEntry[], newsLog: NewsLogEntry[]): string[] {
  const out = new Set<string>();
  for (const e of aiLog) out.add(e.symbol);
  for (const e of newsLog) {
    if (e.price != null && e.priceSymbol) out.add(e.priceSymbol);
  }
  return [...out];
}
