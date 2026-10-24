import type { NewsAssessment } from "../ai/news-analyst";
import type { HeatResult } from "../market/heat";

/** ข่าวที่ AI ประเมินแล้ว (เก็บเฉพาะที่เกี่ยวข้อง) — ใช้ทำสรุปรายวัน + วัดความแม่นภายหลัง */
export type NewsLogEntry = {
  at: number;
  date: string; // ET
  symbols: string[];
  headline: string;
  url: string;
  source: string;
  direction: NewsAssessment["direction"];
  impact: number;
  confidence: NewsAssessment["confidence"];
  category: NewsAssessment["category"];
  why: string;
  /** ราคาตอนเห็นข่าว (IEX) ของ priceSymbol */
  price: number | null;
  priceSymbol: string | null;
  alerted: boolean;
};

export type DailySentiment = { bull: number; bear: number; mixed: number; neutral: number; hype: number; total: number };

/**
 * แยก KV key จาก state ของการแจ้งเตือนราคา เพราะ radar รันบ่อยกว่ามาก (ทุก 30 นาที)
 * ยังเขียนแค่ครั้งเดียวต่อรอบ ~40 ครั้ง/วัน (โควต้า KV ฟรี 1,000/วัน)
 */
export type NewsState = {
  version: 1;
  /** key ของข่าวที่เห็นแล้ว -> เวลา */
  seen: Record<string, number>;
  lastRun: number | null;
  log: NewsLogEntry[];
  /** ET date -> สถิติข่าวของวันนั้น (ใช้ใน Heat Index) */
  sentiment: Record<string, DailySentiment>;
  /** ET date ที่ส่งสรุปรายวันไปแล้ว */
  digestSent: string | null;
  /** ET date ของรอบรายสัปดาห์ล่าสุด */
  weeklySent: string | null;
  heatHistory: Array<{ date: string; score: number; components: HeatResult["components"] }>;
};

export const NEWS_STATE_KEY = "news:v1";
const LOG_MAX = 500;

export function emptyNewsState(): NewsState {
  return { version: 1, seen: {}, lastRun: null, log: [], sentiment: {}, digestSent: null, weeklySent: null, heatHistory: [] };
}

export async function loadNewsState(kv: KVNamespace): Promise<NewsState> {
  const raw = await kv.get<NewsState>(NEWS_STATE_KEY, "json");
  if (!raw || raw.version !== 1) return emptyNewsState();
  return { ...emptyNewsState(), ...raw };
}

export async function saveNewsState(kv: KVNamespace, state: NewsState): Promise<void> {
  await kv.put(NEWS_STATE_KEY, JSON.stringify(state));
}

export function pruneNewsState(state: NewsState, now: number): void {
  for (const [k, at] of Object.entries(state.seen)) {
    if (now - at > 4 * 86_400_000) delete state.seen[k];
  }
  const keep = new Set(Object.keys(state.sentiment).sort().slice(-35));
  for (const d of Object.keys(state.sentiment)) if (!keep.has(d)) delete state.sentiment[d];
  if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX);
  if (state.heatHistory.length > 26) state.heatHistory = state.heatHistory.slice(-26);
}
