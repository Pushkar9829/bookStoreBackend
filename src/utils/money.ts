/** Convert rupees (number or string) to paise integer. */
export function toPaise(rupees: number | string): number {
  const n = typeof rupees === "string" ? Number(rupees) : rupees;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function toRupees(paise: number): number {
  return Math.round(paise) / 100;
}

export function lineTotalPaise(qty: number, unitPaise: number): number {
  return Math.round(qty * unitPaise);
}
