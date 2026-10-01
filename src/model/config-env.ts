export interface Env {
  STOCK_STATE: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  ALPACA_API_KEY: string;
  ALPACA_API_SECRET: string;
  TRIGGER_TOKEN: string;
  /** ไม่ใส่ = ไม่ใช้ AI (แจ้งเตือนทำงานปกติ) */
  ANTHROPIC_API_KEY?: string;

  WATCHLIST: string;
  /** SYMBOL:below=xxx,above=yyy;SYMBOL:... */
  PRICE_LEVELS?: string;
  /** รอบที่ส่ง: "midday,close" (ค่าเริ่มต้น) หรือ "close" อย่างเดียว */
  ALERT_SLOTS?: string;
  /** "sip" (ค่าเริ่มต้น, ดีเลย์ 16 นาที) หรือ "iex" */
  ALPACA_FEED?: string;

  // ปรับความไวได้ (ไม่ใส่ = ใช้ค่าเริ่มต้นใน DEFAULT_THRESHOLDS)
  MOVE_Z?: string;
  MIN_MOVE_PCT?: string;
  TREND_Z?: string;
  MIN_TREND_PCT?: string;
  VOLUME_RATIO?: string;

  /** โมเดล Claude ที่ใช้วิเคราะห์ (ค่าเริ่มต้น claude-opus-5-5) */
  AI_MODEL?: string;
  /** 0 = AI แค่อธิบาย ไม่กรอง; 2 = ตัดหุ้นที่ AI ให้คะแนน 1 (noise) ทิ้ง ฯลฯ */
  AI_MIN_IMPORTANCE?: string;
}
