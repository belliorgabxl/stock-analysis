export interface Env {
  STOCK_STATE: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  ALPACA_API_KEY: string;
  ALPACA_API_SECRET: string;

  WATCHLIST: string;

  PRICE_LEVELS?: string;
  PCT_THRESHOLD?: string;
  ALERT_COOLDOWN_MINUTES?: string;
  TRIGGER_TOKEN: string; 
}