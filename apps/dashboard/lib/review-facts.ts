import type { ReviewQueueItem } from "@internship-agent/agent";

/** Stated pay in the posting's own units, short enough for one card line. */
export function formatPay(pay: ReviewQueueItem["pay"]): string {
  if (!pay || (pay.minimum === null && pay.maximum === null)) return pay?.period === "STIPEND" ? "Stipend" : "Pay not stated";
  const unit = { HOUR: "/hr", MONTH: "/mo", YEAR: "/yr", STIPEND: " stipend" }[pay.period];
  const amount = (value: number) => (value >= 10_000 ? `${Math.round(value / 1_000)}k` : Number.isInteger(value) ? String(value) : value.toFixed(2));
  const prefix = pay.currency === "USD" ? "$" : `${pay.currency} $`;
  const low = pay.minimum ?? pay.maximum!;
  const range = pay.maximum !== null && pay.maximum !== low ? `${amount(low)}–${amount(pay.maximum)}` : amount(low);
  return `${prefix}${range}${unit}`;
}

export function postedAgo(postedAt: string | null, now = Date.now()): string {
  if (!postedAt) return "Date unknown";
  const days = Math.floor((now - Date.parse(postedAt)) / 86_400_000);
  return days <= 0 ? "Posted today" : `Posted ${days}d ago`;
}
