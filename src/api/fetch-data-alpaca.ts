import { Env } from "../model/config-env";

export async function fetchClosesAlpaca(
  symbol: string,
  env: Env,
): Promise<number[]> {
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`);
  url.searchParams.set("timeframe", "1Min");
  url.searchParams.set("limit", "200");

  const res = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
      accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { bars?: Array<{ c: number }> };
  const bars = data.bars ?? [];
  return bars.map((b) => b.c);
}
