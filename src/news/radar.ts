import { assessNews, type NewsAiResult, type NewsAssessment } from "../ai/news-analyst";
import { loadConfig } from "../config";
import { fetchSnapshots, type Snapshot } from "../lib/alpaca";
import { sendDiscord } from "../lib/discord";
import { etParts, isWeekday } from "../lib/time";
import type { Env } from "../model/config-env";
import { buildDigestMessage, buildNewsAlertMessage } from "./message";
import { classifyByRules } from "./rules";
import { alpacaItems, rssItems, secItems, type RawItem } from "./sources";
import { emptyNewsState, loadNewsState, pruneNewsState, saveNewsState, type DailySentiment, type NewsState } from "./state";

export type RadarOptions = {
  now?: Date;
  /** วิเคราะห์อย่างเดียว ไม่ส่ง Discord ไม่บันทึก state */
  dryRun?: boolean;
  /** ข้ามการเช็กเวลา */
  force?: boolean;
  /** ไม่สนข่าวที่เคยเห็นแล้ว (ใช้ทดสอบ) */
  ignoreSeen?: boolean;
  /** ไม่เรียก Claude แม้มี key (ใช้กฎคีย์เวิร์ดแทน) */
  skipAi?: boolean;
};

const MAX_ITEMS = 60;
const MAX_MACRO = 20;

/**
 * cron ยิงทุก 30 นาที (:05, :35) — รันจริงช่วงจันทร์-ศุกร์ 04:00-20:59 ET (pre-market ถึง after-hours)
 * นอกเวลานั้นรันทุก 3 ชม. เพื่อไม่พลาดข่าวใหญ่ช่วงสุดสัปดาห์
 */
export function radarShouldRun(now: Date): boolean {
  const et = etParts(now);
  if (isWeekday(et) && et.hour >= 4 && et.hour <= 20) return true;
  return et.minute < 30 && et.hour % 3 === 0;
}

const normHeadline = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function runNewsRadar(env: Env, opts: RadarOptions = {}) {
  const cfg = loadConfig(env);
  const now = opts.now ?? new Date();
  const et = etParts(now);
  if (!cfg.news.enabled) return { status: "skipped", reason: "NEWS_RADAR=off" };
  if (!opts.force && !opts.dryRun && !radarShouldRun(now)) {
    return { status: "skipped", reason: `outside radar hours (ET ${et.hour}:${et.minute})` };
  }

  const stored = await loadNewsState(env.STOCK_STATE);
  const state: NewsState = opts.dryRun ? structuredClone(stored) : stored;
  const seen = opts.ignoreSeen ? emptyNewsState().seen : state.seen;

  // ทับซ้อนกับรอบก่อน 1 ชม. เผื่อข่าวที่ถูกแท็กช้า (ข่าวซ้ำถูกกรองด้วย seen อยู่แล้ว)
  const since = new Date(Math.max(now.getTime() - 12 * 3_600_000, (state.lastRun ?? 0) - 3_600_000));
  const newsSymbols = [...new Set([...cfg.symbols, ...cfg.news.extraSymbols])];

  const warn = (what: string) => (err: unknown) => {
    console.warn(`[radar] ${what} failed`, err);
    return [] as RawItem[];
  };
  const [company, filings, macro, snapshots] = await Promise.all([
    alpacaItems(newsSymbols, env, since).catch(warn("alpaca news")),
    cfg.news.secUserAgent ? secItems(cfg.symbols, cfg.news.secUserAgent, since).catch(warn("sec")) : Promise.resolve([]),
    rssItems(cfg.news.rssFeeds, since).catch(warn("rss")),
    fetchSnapshots(newsSymbols, env).catch((err) => {
      console.warn("[radar] snapshots failed", err);
      return {} as Record<string, Snapshot>;
    }),
  ]);

  // ข่าวใหม่เท่านั้น + ตัดพาดหัวซ้ำข้ามแหล่ง
  const headlines = new Set<string>();
  const fresh = (list: RawItem[]) =>
    list
      .filter((it) => {
        const h = normHeadline(it.headline);
        if (seen[it.key] || headlines.has(h)) return false;
        headlines.add(h);
        return true;
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const freshCompany = fresh([...filings, ...company]);
  const freshMacro = fresh(macro).slice(0, MAX_MACRO);
  const batch = [...freshCompany, ...freshMacro].slice(0, MAX_ITEMS);
  for (const it of [...freshCompany, ...freshMacro]) state.seen[it.key] = now.getTime();

  const recentAlerts = state.log
    .filter((e) => e.alerted && now.getTime() - e.at < 86_400_000)
    .map((e) => `${e.symbols.join(",")}: ${e.headline}`);

  let ai: NewsAiResult | null = null;
  const useAi = Boolean(env.ANTHROPIC_API_KEY) && !opts.skipAi;
  if (batch.length && useAi) {
    ai = await assessNews(env.ANTHROPIC_API_KEY!, cfg.news.model, batch, newsSymbols, snapshots, recentAlerts);
  }

  const isAlert = (a: NewsAssessment) =>
    a.relevant && !a.duplicate && a.impact >= cfg.news.minImpact && a.confidence !== "low" && a.direction !== "neutral";
  // ไม่มี key / เรียก AI ไม่สำเร็จ = คัดด้วยกฎคีย์เวิร์ด (ฟรี)
  const result: NewsAiResult | null =
    ai ?? (batch.length ? { model: "rules", assessments: classifyByRules(batch, state.log, now.getTime()), summary: "" } : null);
  const alerts = result?.assessments.filter(isAlert) ?? [];

  if (result) {
    const day = (state.sentiment[et.date] ??= { bull: 0, bear: 0, mixed: 0, neutral: 0, hype: 0, total: 0 });
    for (const a of result.assessments) {
      if (!a.relevant) continue;
      countSentiment(day, a);
      if (a.impact < 3 && !isAlert(a)) continue;
      const sym = a.symbols.find((s) => snapshots[s]);
      state.log.push({
        at: now.getTime(),
        date: et.date,
        symbols: a.symbols,
        headline: a.item.headline,
        url: a.item.url,
        source: a.item.source,
        direction: a.direction,
        impact: a.impact,
        confidence: a.confidence,
        category: a.category,
        why: a.why,
        price: sym ? snapshots[sym].price : null,
        priceSymbol: sym ?? null,
        alerted: isAlert(a),
      });
    }
  }

  const payloads: unknown[] = [];
  if (alerts.length) payloads.push(buildNewsAlertMessage(alerts, snapshots, result?.summary ?? "", ai ? "ai" : "rules"));

  // สรุปรายวันหลังตลาดปิด (รอบแรกที่ ET ≥ 20:00 วันทำการ)
  let digest = false;
  if (isWeekday(et) && et.hour >= 20 && state.digestSent !== et.date) {
    const entries = state.log.filter((e) => e.date === et.date);
    if (entries.length) payloads.push(buildDigestMessage(et.date, entries, state.sentiment[et.date]));
    state.digestSent = et.date;
    digest = entries.length > 0;
  }

  if (!opts.dryRun) {
    for (const p of payloads) await sendDiscord(cfg.news.webhook, p);
    state.lastRun = now.getTime();
    pruneNewsState(state, now.getTime());
    await saveNewsState(env.STOCK_STATE, state);
  }

  return {
    status: "ok",
    since: since.toISOString(),
    fetched: { company: company.length, filings: filings.length, macro: macro.length, sec: Boolean(cfg.news.secUserAgent) },
    fresh: batch.length,
    classifier: ai ? ai.model : useAi && batch.length ? "rules (AI failed)" : "rules",
    ...(ai?.summary ? { summary: ai.summary } : {}),
    sent: !opts.dryRun && payloads.length > 0,
    digest,
    alerts: alerts.map(brief),
    assessed: result?.assessments.filter((a) => a.relevant).sort((a, b) => b.impact - a.impact).map(brief),
    ...(opts.dryRun ? { payloads } : {}),
  };
}

function countSentiment(day: DailySentiment, a: NewsAssessment) {
  day.total++;
  if (a.hype) day.hype++;
  if (a.direction === "bullish") day.bull++;
  else if (a.direction === "bearish") day.bear++;
  else if (a.direction === "mixed") day.mixed++;
  else day.neutral++;
}

const brief = (a: NewsAssessment) => ({
  symbols: a.symbols,
  direction: a.direction,
  impact: a.impact,
  confidence: a.confidence,
  category: a.category,
  duplicate: a.duplicate,
  headline: a.item.headline,
  why: a.why,
});
