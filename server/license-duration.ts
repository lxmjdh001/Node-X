export type LicenseUnit = 'days' | 'months';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Months preserve the time of day in Shanghai and clamp to the target month's last day. */
export function licenseExpiry(start: number, unit: LicenseUnit, quantity: number): number {
  if (unit === 'days') return start + quantity * DAY_MS;

  const date = new Date(start + SHANGHAI_OFFSET_MS);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + quantity);
  const maximum = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, maximum));
  return date.getTime() - SHANGHAI_OFFSET_MS;
}
