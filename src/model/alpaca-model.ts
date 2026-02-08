export type AlpacaSnapshot = {
  latestTrade?: { p: number; t: string };
  minuteBar?: { c: number; t: string };
  dailyBar?: { c: number; t: string };
  prevDailyBar?: { c: number; t: string };
};

export type RuleState = {
  lastAlertAt?: number;
  lastSide?: "above" | "below";
};