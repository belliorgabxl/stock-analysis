import { assessAlerts } from "../ai/analyst";
import { DIR_EMOJI, stars } from "../news/message";
import { analyze } from "../analysis/signals";
import { loadConfig, parseSymbols } from "../config";
import { fetchDailyBars, fetchNews } from "../lib/alpaca";
import { buildMessage } from "../lib/discord";
import { etParts, isWeekday, sessionVolumeFraction } from "../lib/time";
import { computeMarketReport, heatEmbed, reviewEmbed } from "../market/weekly";
import type { Env } from "../model/config-env";
import { loadNewsState } from "../news/state";

/**
 * Discord slash commands (/analyze, /news, /heat, /review)
 * Discord ส่ง POST มาที่ /interactions — ต้องตรวจลายเซ็น Ed25519 ทุกครั้ง และตอบภายใน 3 วินาที
 * จึงตอบ "กำลังคิด..." (deferred) ก่อน แล้วค่อยแก้ข้อความทีหลังผ่าน waitUntil
 */

type Interaction = {
  type: number;
  token: string;
  application_id: string;
  data?: { name: string; options?: Array<{ name: string; value: string | number | boolean }> };
  member?: { user?: { id: string } };
  user?: { id: string };
};

const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL = 1 << 6;

const hexToBytes = (hex: string) => new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));

export async function verifyDiscordRequest(body: string, signature: string, timestamp: string, publicKey: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/** คืน response ทันที + งานที่ต้องทำต่อเบื้องหลัง (ถ้ามี) */
export function handleInteraction(env: Env, interaction: Interaction): { response: unknown; background?: Promise<void> } {
  if (interaction.type === PING) return { response: { type: PONG } };
  if (interaction.type !== APPLICATION_COMMAND || !interaction.data) {
    return { response: { type: CHANNEL_MESSAGE, data: { content: "ไม่รู้จักคำสั่งนี้", flags: EPHEMERAL } } };
  }

  const cfg = loadConfig(env);
  const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "";
  if (cfg.discord.allowedUserIds.length && !cfg.discord.allowedUserIds.includes(userId)) {
    return { response: { type: CHANNEL_MESSAGE, data: { content: "⛔ คุณไม่มีสิทธิ์ใช้คำสั่งนี้", flags: EPHEMERAL } } };
  }

  const opt = (name: string) => interaction.data?.options?.find((o) => o.name === name)?.value;
  const name = interaction.data.name;
  const run = async (): Promise<unknown> => {
    if (name === "analyze") return analyzeCommand(env, String(opt("symbol") ?? ""));
    if (name === "news") return newsCommand(env, opt("symbol") ? String(opt("symbol")) : null);
    if (name === "heat") {
      const { et, heat, prev } = await computeMarketReport(env, new Date());
      return heat ? { embeds: [heatEmbed(et.date, heat, prev?.score ?? null)] } : { content: "ข้อมูล QQQ ไม่พอ" };
    }
    if (name === "review") {
      const { review } = await computeMarketReport(env, new Date());
      return { embeds: [reviewEmbed(review)] };
    }
    return { content: `ไม่รู้จักคำสั่ง /${name}` };
  };

  const background = run()
    .catch((err) => {
      console.error(`[discord] /${name} failed`, err);
      return { content: `❌ /${name} ล้มเหลว: ${String(err).slice(0, 300)}` };
    })
    .then((payload) => editOriginal(interaction, payload));

  return { response: { type: DEFERRED_CHANNEL_MESSAGE }, background };
}

async function editOriginal(interaction: Interaction, payload: unknown) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...(payload as object) }),
  });
  if (!res.ok) console.error("[discord] edit original failed", res.status, await res.text().catch(() => ""));
}

async function analyzeCommand(env: Env, rawSymbol: string) {
  const [symbol] = parseSymbols(rawSymbol);
  if (!symbol || !/^[A-Z.]{1,10}$/.test(symbol)) return { content: "ใส่ ticker ให้ถูกต้อง เช่น `/analyze NVDA`" };

  const cfg = loadConfig(env);
  const now = new Date();
  const et = etParts(now);
  const { bars, feed, asOf } = await fetchDailyBars([symbol], env, cfg.feed, now);
  const b = bars[symbol] ?? [];
  const intraday = b.at(-1)?.date === et.date && isWeekday(et) && et.hour < 16;
  const analysis = analyze(b, "close", intraday ? sessionVolumeFraction(asOf) : 1, cfg.thresholds);
  if (!analysis) return { content: `ไม่พบข้อมูลราคาของ ${symbol}` };

  const signals = analysis.signals.length
    ? analysis.signals
    : [{ id: "manual", kind: "move" as const, dir: (analysis.metrics.changePct >= 0 ? 1 : -1) as 1 | -1, score: 0, magnitude: 0, cooldownDays: 0, text: "ไม่มีสัญญาณผิดปกติ (ผู้ใช้ขอวิเคราะห์เอง)" }];
  const alert = { symbol, metrics: analysis.metrics, signals, score: 0 };
  const news = await fetchNews([symbol], env, new Date(now.getTime() - 72 * 3_600_000), 5).catch(() => ({}));
  const ai = env.ANTHROPIC_API_KEY
    ? await assessAlerts(env.ANTHROPIC_API_KEY, cfg.ai.model, [alert], news, { [symbol]: analysis.metrics }, analysis.metrics.date)
    : null;

  const msg = buildMessage([alert], news, { slot: intraday ? "midday" : "close", date: analysis.metrics.date, feed, asOf }, ai);
  return { content: `🔎 **วิเคราะห์ ${symbol}**${ai ? "" : " (ไม่มี AI)"}`, embeds: msg.embeds };
}

async function newsCommand(env: Env, rawSymbol: string | null) {
  const [symbol] = parseSymbols(rawSymbol ?? "");
  const state = await loadNewsState(env.STOCK_STATE);
  const since = Date.now() - 48 * 3_600_000;
  const entries = state.log
    .filter((e) => e.at >= since && (!symbol || e.symbols.includes(symbol)))
    .sort((a, b) => b.impact - a.impact || b.at - a.at)
    .slice(0, 12);
  if (!entries.length) return { content: `ไม่มีข่าวสำคัญ${symbol ? `ของ ${symbol}` : ""}ใน 48 ชม. ที่ผ่านมา` };
  const lines = entries.map(
    (e) => `${DIR_EMOJI[e.direction]} **${e.symbols.join(",") || "ตลาด"}** ${stars(e.impact)} [${e.headline.slice(0, 120)}](${e.url})${e.why ? `\n-# ${e.why}` : ""}`,
  );
  return {
    content: `📰 **ข่าวสำคัญ 48 ชม.${symbol ? ` — ${symbol}` : ""}**`,
    embeds: [{ description: lines.join("\n").slice(0, 4000), color: 0xf1c40f }],
  };
}
