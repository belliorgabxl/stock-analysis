import { fmtPrice, type Metrics } from "../analysis/signals";
import type { SymbolAlert } from "../alerts/evaluate";
import type { Feed, NewsItem } from "./alpaca";
import { etParts, type Slot } from "./time";

export async function sendDiscord(webhookUrl: string, payload: unknown) {
  if (!webhookUrl || webhookUrl.trim() === "") {
    throw new Error("DISCORD_WEBHOOK_URL is missing (undefined/empty)");
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

const MAX_EMBEDS = 10; // ข้อจำกัดของ Discord
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;

const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function thaiDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y}`;
}

function contextLine(m: Metrics): string {
  const parts: string[] = [];
  if (m.rsi14 != null) {
    const tag = m.rsi14 >= 70 ? " (overbought)" : m.rsi14 <= 30 ? " (oversold)" : "";
    parts.push(`RSI ${m.rsi14.toFixed(0)}${tag}`);
  }
  if (m.sma50 != null) parts.push(`SMA50 ${pct((m.price / m.sma50 - 1) * 100, 0)}`);
  if (m.sma200 != null) parts.push(`SMA200 ${pct((m.price / m.sma200 - 1) * 100, 0)}`);
  if (m.high52 != null) {
    const fromHigh = (m.price / m.high52 - 1) * 100;
    parts.push(fromHigh >= 0 ? "ที่จุดสูงสุด 52w" : `ห่างจุดสูงสุด 52w ${pct(fromHigh, 0)}`);
  }
  if (m.change5Pct != null) parts.push(`5 วัน ${pct(m.change5Pct)}`);
  return parts.join(" · ");
}

function embedFor(a: SymbolAlert, news: NewsItem[]) {
  const m = a.metrics;
  const up = a.signals.reduce((s, x) => s + x.dir * x.score, 0) >= 0;
  const lines = a.signals.map((s) => `• ${s.text}`);
  lines.push("", `-# ${contextLine(m)}`);
  if (news.length) {
    lines.push("", "📰 **ข่าวล่าสุด**");
    for (const n of news) lines.push(`• [${n.headline.slice(0, 140)}](${n.url})`);
  }
  return {
    title: `${up ? "🟢" : "🔴"} ${a.symbol}  $${fmtPrice(m.price)}  (${pct(m.changePct)})`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(a.symbol)}`,
    color: up ? GREEN : RED,
    description: lines.join("\n").slice(0, 4000),
  };
}

export function buildMessage(
  alerts: SymbolAlert[],
  news: Record<string, NewsItem[]>,
  ctx: { slot: Slot; date: string; feed: Feed; asOf: Date },
) {
  const shown = alerts.slice(0, MAX_EMBEDS);
  const rest = alerts.slice(MAX_EMBEDS);
  const slotName = ctx.slot === "midday" ? "ระหว่างวัน" : "ปิดตลาด";
  const t = etParts(ctx.asOf);
  const asOf = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")} ET`;

  let content = `📊 **หุ้นที่มีความเคลื่อนไหวสำคัญ — ${slotName} ${thaiDate(ctx.date)}** (${alerts.length} ตัว, ข้อมูล ${ctx.feed.toUpperCase()} ณ ${asOf})`;
  if (rest.length) {
    content += `\nอื่นๆ: ${rest.map((a) => `${a.symbol} ${pct(a.metrics.changePct)}`).join(", ")}`;
  }

  return {
    content,
    embeds: shown.map((a) => embedFor(a, news[a.symbol] ?? [])),
    allowed_mentions: { parse: [] },
  };
}
