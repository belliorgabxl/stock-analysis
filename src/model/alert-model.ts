export type AlertState = {
  lastSentAt?: Record<string, number>;     // key -> epoch ms
  lastCond?: Record<string, boolean>;      // key -> boolean
};