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

  // ---- News Radar ----
  /** "off" = ปิด News Radar */
  NEWS_RADAR?: string;
  /** โมเดลที่ใช้คัดข่าว (ไม่ใส่ = ใช้ AI_MODEL) */
  NEWS_AI_MODEL?: string;
  /** เตือนทันทีเมื่อผลกระทบ ≥ ค่านี้ (ค่าเริ่มต้น 4) */
  NEWS_MIN_IMPACT?: string;
  /** ติดตามข่าวหุ้นเพิ่ม (ไม่คำนวณสัญญาณราคา) เช่น "AMD,TSLA,PLTR" */
  NEWS_EXTRA_SYMBOLS?: string;
  /** RSS ข่าวมหภาค คั่นด้วย , (ไม่ใส่ = CNBC + MarketWatch) */
  NEWS_RSS_FEEDS?: string;
  /** SEC บังคับ User-Agent แบบ "ชื่อ อีเมล" เช่น "MyStockBot me@example.com" — ไม่ใส่ = ข้าม SEC */
  SEC_USER_AGENT?: string;
  /** ส่งข่าวไปห้องแยก (ไม่ใส่ = ใช้ DISCORD_WEBHOOK_URL) */
  DISCORD_NEWS_WEBHOOK_URL?: string;

  // ---- Heat Index ----
  /** หุ้นที่ใช้วัด breadth คั่นด้วย , */
  HEAT_BASKET?: string;

  // ---- Discord slash commands ----
  DISCORD_PUBLIC_KEY?: string;
  /** user id ที่ใช้คำสั่งได้ คั่นด้วย , (ไม่ใส่ = ทุกคนในเซิร์ฟเวอร์) */
  DISCORD_ALLOWED_USER_IDS?: string;
}
