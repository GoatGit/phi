const DAY_MS = 86_400_000;

/** Validate the exact Decimal range used by the ledger without floating point. */
export function isLedgerAmount(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  const significantFraction = fraction.replace(/0+$/, "");
  if (significantFraction.length > 28) return false;
  const digits = (whole + significantFraction).replace(/^0+/, "") || "0";
  return (
    digits.length <= 29 && BigInt(digits) <= 79228162514264337593543950335n
  );
}

/** Keep date inputs as strings until submission, including an empty draft. */
export function utcInputDate(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const iso = date.toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : "";
}

export function parseBillingPeriod(
  since: string,
  until: string,
): { since: number; until: number } | null {
  if (
    ![since, until].every(
      (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000"),
    )
  )
    return null;
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  if (
    utcInputDate(start) !== since ||
    utcInputDate(end) !== until ||
    end <= start ||
    end - start > 366 * DAY_MS
  )
    return null;
  return { since: start, until: end };
}
