import { describe, expect, it } from "vitest";
import {
  isLedgerAmount,
  parseBillingPeriod,
  utcInputDate,
} from "@/lib/financialInput";

describe("exact financial input", () => {
  it.each([
    "0",
    "0.00",
    "2.50",
    "9007199254740993.01",
    "79228162514264337593543950335",
    "79228162514264337593543950335.0",
    "0.0000000000000000000000000001",
  ])(
    "accepts representable decimal %s without a float conversion",
    (amount) => {
      expect(isLedgerAmount(amount)).toBe(true);
    },
  );
  it.each([
    "",
    " ",
    "-1",
    "NaN",
    "Infinity",
    "1e2",
    "1,000",
    "1.2.3",
    "79228162514264337593543950336",
    "7922816251426433759354395033.6",
    "0.00000000000000000000000000001",
  ])("rejects invalid or inexact amount %s", (amount) => {
    expect(isLedgerAmount(amount)).toBe(false);
  });
  it("uses UTC midnights and accepts the 366-day boundary", () => {
    expect(parseBillingPeriod("2024-01-01", "2025-01-01")).toEqual({
      since: Date.UTC(2024, 0, 1),
      until: Date.UTC(2025, 0, 1),
    });
    expect(parseBillingPeriod("2024-02-29", "2024-03-01")).not.toBeNull();
    expect(parseBillingPeriod("0001-01-01", "0001-01-02")).not.toBeNull();
  });
  it.each([
    ["", "2026-10-01"],
    ["2026-10-01", ""],
    ["2026-10-01", "2026-10-01"],
    ["2026-10-02", "2026-10-01"],
    ["2023-02-29", "2023-03-01"],
    ["2026-02-30", "2026-03-01"],
    ["2026-1-01", "2026-02-01"],
    ["0000-01-01", "0001-01-01"],
    ["2024-01-01", "2025-01-02"],
    ["9999-12-01", "10000-01-01"],
  ])("rejects invalid billing period %s → %s", (since, until) => {
    expect(parseBillingPeriod(since, until)).toBeNull();
  });
  it("handles invalid stored timestamps without throwing during render", () => {
    for (const value of [NaN, Infinity, 1e20])
      expect(utcInputDate(value)).toBe("");
    expect(utcInputDate(Date.UTC(2026, 9, 13, 23))).toBe("2026-10-13");
  });
});
