import { AlertState } from "../model/alert-model";
import { AlpacaSnapshot } from "../model/alpaca-model";
import { Env } from "../model/config-env";

export async function sendDiscord(webhookUrl: string, payload: unknown) {
  if (!webhookUrl || webhookUrl.trim() === "") {
    throw new Error("DISCORD_WEBHOOK_URL is missing (undefined/empty)");
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
}

export function parsePriceLevels(
  input: string,
): Record<string, { below?: number; above?: number }> {
  // format: AAPL:below=170,above=200;TSLA:below=180,above=260
  const out: Record<string, { below?: number; above?: number }> = {};
  if (!input || input.trim() === "") return out;

  for (const chunk of input.split(";")) {
    const part = chunk.trim();
    if (!part) continue;

    const [symRaw, rulesRaw] = part.split(":");
    const symbol = (symRaw ?? "").trim().toUpperCase();
    if (!symbol || !rulesRaw) continue;

    const rules: { below?: number; above?: number } = {};
    for (const kv of rulesRaw.split(",")) {
      const [k, v] = kv.split("=").map((x) => x.trim());
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      if (k === "below") rules.below = num;
      if (k === "above") rules.above = num;
    }

    out[symbol] = rules;
  }

  return out;
}

export async function fetchSnapshotsAlpaca(
  symbols: string[],
  env: Env,
): Promise<Record<string, AlpacaSnapshot>> {
  const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
  url.searchParams.set("symbols", symbols.join(","));

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
      accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca snapshots error ${res.status}: ${text}`);
  }

  return (await res.json()) as Record<string, AlpacaSnapshot>;
}

type Detail = {
  symbol: string;
  sent: string[];
  currentPrice?: number;
  prevClose?: number | null;
  changePct?: number | null;
  rules?: { below?: number; above?: number };
  note?: string;
};

export async function runAlertsOnce(
  env: Env,
  opts?: { force?: boolean; symbols?: string[] },
) {
  const symbols = opts?.symbols?.length
    ? opts.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : (env.WATCHLIST ?? "AAPL,TSLA")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

  const priceLevels = parsePriceLevels(env.PRICE_LEVELS ?? "");
  const pctThreshold = Number(env.PCT_THRESHOLD ?? "10");
  const cooldownMin = Number(env.ALERT_COOLDOWN_MINUTES ?? "30");
  const cooldownMs = cooldownMin * 60 * 1000;

  const snapshots = await fetchSnapshotsAlpaca(symbols, env);

  let sent = 0;
  const details: Detail[] = [];

  for (const symbol of symbols) {
    const sentKeys: string[] = [];
    const detail: Detail = { symbol, sent: sentKeys };

    try {
      const snap = snapshots[symbol];
      if (!snap) {
        detail.note = "no snapshot";
        details.push(detail);
        continue;
      }

      const currentPrice = snap.latestTrade?.p ?? snap.minuteBar?.c ?? null;
      const prevClose = snap.prevDailyBar?.c ?? null;

      detail.currentPrice = currentPrice ?? undefined;
      detail.prevClose = prevClose;

      if (currentPrice == null) {
        detail.note = "no current price";
        details.push(detail);
        continue;
      }

      const changePct =
        prevClose && prevClose > 0
          ? ((currentPrice - prevClose) / prevClose) * 100
          : null;

      detail.changePct = changePct;

      const stateKey = `alerts:${symbol}`;
      const state: AlertState =
        (await env.STOCK_STATE.get(stateKey, "json")) ?? {};
      state.lastSentAt ??= {};
      state.lastCond ??= {};

      const rules = priceLevels[symbol] ?? {};
      detail.rules = rules;

      const condPriceBelow =
        typeof rules.below === "number" ? currentPrice <= rules.below : false;
      const condPriceAbove =
        typeof rules.above === "number" ? currentPrice >= rules.above : false;

      const condPctUp = changePct != null ? changePct >= +pctThreshold : false;
      const condPctDown =
        changePct != null ? changePct <= -pctThreshold : false;

      const tryAlert = async (key: string, cond: boolean, message: string) => {
        const now = Date.now();

        if (opts?.force) {
          // force = ถ้าเข้าเงื่อนไขก็ยิงทันที ไม่สน cooldown/prev
          if (cond) {
            await sendDiscord(env.DISCORD_WEBHOOK_URL, { content: message });
            sent++;
            sentKeys.push(key);
          }
          return;
        }

        const prev = state.lastCond?.[key] ?? false;
        const last = state.lastSentAt?.[key] ?? 0;

        if (cond && !prev && now - last >= cooldownMs) {
          await sendDiscord(env.DISCORD_WEBHOOK_URL, { content: message });
          state.lastSentAt![key] = now;
          sent++;
          sentKeys.push(key);
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

      if (typeof rules.above === "number") {
        await tryAlert(
          "price_above",
          condPriceAbove,
          `\n\n==================================================\n🔺 ${symbol} สูงกว่าเป้า\nราคา: ${priceText} (เป้า > $${rules.above.toFixed(
            2,
          )})\nPrevClose: ${prevText} | Change: ${pctText}\n`,
        );
      }

      await tryAlert(
        "pct_up",
        condPctUp,
        `\n\n==================================================\n📈 ${symbol} ขึ้นแรงเกิน +${pctThreshold}%\nราคา: ${priceText}\nPrevClose: ${prevText} | Change: ${pctText}\n`,
      );

      await tryAlert(
        "pct_down",
        condPctDown,
        `\n\n==================================================\n📉 ${symbol} ลงแรงเกิน -${pctThreshold}%\nราคา: ${priceText}\nPrevClose: ${prevText} | Change: ${pctText}\n`,
      );

      if (!opts?.force) {
        await env.STOCK_STATE.put(stateKey, JSON.stringify(state));
      }

      details.push(detail);
    } catch (err) {
      console.error(`[trigger] ${symbol} failed`, err);
      detail.note = "error";
      details.push(detail);
    }
  }

  return { ok: true, symbols: symbols.length, sent, details };
}