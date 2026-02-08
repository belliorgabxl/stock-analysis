import { Hono } from "hono";

import { fetchSnapshotsAlpaca, runAlertsOnce } from "./utils/send-discord";
import { parsePriceLevels } from "./utils/send-discord";
import { sendDiscord } from "./utils/send-discord";

import { fetchClosesAlpaca } from "./api/fetch-data-alpaca";
import type { Env } from "./model/config-env";

import { AlertState } from "./model/alert-model";

// import { computeRSI } from "./utils/indicators";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/test-discord", async (c) => {
  await sendDiscord(c.env.DISCORD_WEBHOOK_URL, {
    content: "✅ Discord webhook works! (from Cloudflare Workers)",
  });
  return c.text("OK");
});

app.get("/test-alpaca", async (c) => {
  const closes = await fetchClosesAlpaca("NVDA", c.env);
  return c.json({
    symbol: "NVDA",
    lastClose: closes.at(-1),
    count: closes.length,
  });
});

app.post("/trigger-alerts", async (c) => {
  const token = c.req.header("x-trigger-token");
  if (!token || token !== c.env.TRIGGER_TOKEN) {
    return c.text("Unauthorized", 401);
  }

  // optional body: { force?: boolean, symbols?: string[] }
  const body = await c.req.json().catch(() => ({}) as any);
  const force = Boolean(body?.force);
  const symbols = Array.isArray(body?.symbols) ? body.symbols : undefined;

  const result = await runAlertsOnce(c.env, { force, symbols });
  return c.json(result);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env: Env) {
  const symbols = (env.WATCHLIST ?? "AAPL,TSLA")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const priceLevels = parsePriceLevels(env.PRICE_LEVELS ?? "");

  const pctThreshold = Number(env.PCT_THRESHOLD ?? "10");
  const cooldownMin = Number(env.ALERT_COOLDOWN_MINUTES ?? "30");
  const cooldownMs = cooldownMin * 60 * 1000;

  const snapshots = await fetchSnapshotsAlpaca(symbols, env);

  for (const symbol of symbols) {
    try {
      const snap = snapshots[symbol];
      if (!snap) continue;

      const currentPrice = snap.latestTrade?.p ?? snap.minuteBar?.c ?? null;

      const prevClose = snap.prevDailyBar?.c ?? null;

      if (currentPrice == null) continue;

      const changePct =
        prevClose && prevClose > 0
          ? ((currentPrice - prevClose) / prevClose) * 100
          : null;

      const stateKey = `alerts:${symbol}`;
      const state: AlertState =
        (await env.STOCK_STATE.get(stateKey, "json")) ?? {};

      state.lastSentAt ??= {};
      state.lastCond ??= {};

      const rules = priceLevels[symbol] ?? {};
      const condPriceBelow =
        typeof rules.below === "number" ? currentPrice <= rules.below : false;
      const condPriceAbove =
        typeof rules.above === "number" ? currentPrice >= rules.above : false;

      const condPctUp = changePct != null ? changePct >= +pctThreshold : false;
      const condPctDown =
        changePct != null ? changePct <= -pctThreshold : false;

      const tryAlert = async (key: string, cond: boolean, message: string) => {
        const prev = state.lastCond?.[key] ?? false;
        const last = state.lastSentAt?.[key] ?? 0;
        const now = Date.now();

        if (cond && !prev && now - last >= cooldownMs) {
          await sendDiscord(env.DISCORD_WEBHOOK_URL, { content: message });
          state.lastSentAt![key] = now;
        }

        state.lastCond![key] = cond;
      };

      const priceText = `$${currentPrice.toFixed(2)}`;
      const pctText =
        changePct == null
          ? "n/a"
          : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
      const prevText = prevClose == null ? "n/a" : `$${prevClose.toFixed(2)}`;

      if (typeof rules.below === "number") {
        await tryAlert(
          "price_below",
          condPriceBelow,
          `\n\n==================================================\n🔻 ${symbol} ต่ำกว่าเป้า\nราคา: ${priceText} (เป้า < $${rules.below.toFixed(
            2,
          )})\nPrevClose: ${prevText} | Change: ${pctText}\n`,
        );
      }

      // 2) สูงกว่าเป้า
      if (typeof rules.above === "number") {
        await tryAlert(
          "price_above",
          condPriceAbove,
          `\n\n==================================================\n🔺 ${symbol} สูงกว่าเป้า\nราคา: ${priceText} (เป้า > $${rules.above.toFixed(
            2,
          )})\nPrevClose: ${prevText} | Change: ${pctText}\n`,
        );
      }

      // 3) +10% จากวันก่อน
      await tryAlert(
        "pct_up",
        condPctUp,
        `\n\n==================================================\n📈 ${symbol} ขึ้นแรงเกิน +${pctThreshold}%\nราคา: ${priceText}\nPrevClose: ${prevText} | Change: ${pctText}\n`,
      );

      // 4) -10% จากวันก่อน
      await tryAlert(
        "pct_down",
        condPctDown,
        `\n\n==================================================\n 📉 ${symbol} ลงแรงเกิน -${pctThreshold}%\nราคา: ${priceText}\nPrevClose: ${prevText} | Change: ${pctText}\n`,
      );

      await env.STOCK_STATE.put(stateKey, JSON.stringify(state));
    } catch (err) {
      console.error(`[cron] ${symbol} failed`, err);
    }
  }
}
