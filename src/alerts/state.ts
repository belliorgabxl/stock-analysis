import type { Driver } from "../ai/analyst";
import type { LevelState, Signal } from "../analysis/signals";
import { daysBetween } from "../lib/time";

export type SentEntry = { at: number; date: string; mag: number };

/** บันทึกการประเมินของ AI — ไว้เทียบกับราคาจริงภายหลัง เพื่อดูว่า AI ประเมินแม่นแค่ไหน */
export type AiLogEntry = {
  date: string;
  slot: string;
  symbol: string;
  price: number;
  changePct: number;
  signals: string[];
  driver: Driver;
  importance: number;
  why: string;
  /** ถูกตัดทิ้งเพราะ importance ต่ำกว่า AI_MIN_IMPORTANCE */
  dropped: boolean;
};

const AI_LOG_MAX = 300;

/**
 * เก็บทุกอย่างใน KV key เดียว และเขียนแค่ตอนจบแต่ละรอบ (~2 ครั้ง/วัน)
 * — ของเดิมเขียนทุกหุ้นทุก 5 นาที (~3,400 ครั้ง/วัน) เกินโควต้า KV ฟรี (1,000/วัน)
 *   ทำให้ state บันทึกไม่ได้แล้วเตือนซ้ำรัวๆ
 */
export type AlertState = {
  version: 2;
  /** `${date}:${slot}` -> เวลาที่รัน (กัน cron ซ้ำ) */
  runs: Record<string, number>;
  /** `${symbol}|${signalId}` -> ครั้งล่าสุดที่เตือน */
  sent: Record<string, SentEntry>;
  levels: Record<string, LevelState>;
  aiLog: AiLogEntry[];
};

export const STATE_KEY = "state:v2";

export function emptyState(): AlertState {
  return { version: 2, runs: {}, sent: {}, levels: {}, aiLog: [] };
}

export async function loadState(kv: KVNamespace): Promise<AlertState> {
  const raw = await kv.get<AlertState>(STATE_KEY, "json");
  if (!raw || raw.version !== 2) return emptyState();
  return { ...emptyState(), ...raw };
}

export async function saveState(kv: KVNamespace, state: AlertState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

export function shouldSend(
  state: AlertState,
  symbol: string,
  sig: Signal,
  today: string,
  now: number,
): boolean {
  const prev = state.sent[`${symbol}|${sig.id}`];
  if (!prev) return true;

  if (sig.cooldownDays > 0) return daysBetween(prev.at, now) >= sig.cooldownDays - 0.1;

  // cooldown 0 = วันละครั้ง, แต่ถ้ารุนแรงขึ้นมากระหว่างวันก็เตือนซ้ำได้
  if (prev.date !== today) return true;
  return sig.escalateBy != null && sig.magnitude >= prev.mag + sig.escalateBy;
}

export function recordSent(
  state: AlertState,
  symbol: string,
  sig: Signal,
  today: string,
  now: number,
): void {
  state.sent[`${symbol}|${sig.id}`] = { at: now, date: today, mag: sig.magnitude };
}

export function pruneState(state: AlertState, now: number): void {
  for (const [k, v] of Object.entries(state.sent)) {
    if (daysBetween(v.at, now) > 40) delete state.sent[k];
  }
  for (const [k, at] of Object.entries(state.runs)) {
    if (daysBetween(at, now) > 7) delete state.runs[k];
  }
  if (state.aiLog.length > AI_LOG_MAX) state.aiLog = state.aiLog.slice(-AI_LOG_MAX);
}
