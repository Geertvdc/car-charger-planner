import { describe, expect, it } from "vitest";
import { allInPrice, feedInPrice } from "./pricing";

// Dutch dynamic-tariff defaults, matching the Prisma schema.
const markup = {
  energyTaxPerKwh: 0.1088,
  supplierFeePerKwh: 0.02,
  vatRate: 0.21,
  feedInBasis: "market",
  feedInFeePerKwh: 0.02,
  feedInInclVat: true,
  feedInTariffPerKwh: 0,
};

describe("allInPrice", () => {
  it("adds tax and fee, then VAT", () => {
    // (0.08 + 0.1088 + 0.02) * 1.21
    expect(allInPrice(0.08, markup)).toBeCloseTo(0.2526, 4);
  });

  it("clamps at zero — you are never paid to consume", () => {
    expect(allInPrice(-0.5, markup)).toBe(0);
  });
});

describe("feedInPrice", () => {
  it("excludes the energy tax, which is never refunded on export", () => {
    // (0.08 + 0.02) * 1.21 — no energyTaxPerKwh anywhere.
    expect(feedInPrice(0.08, markup)).toBeCloseTo(0.121, 4);
  });

  it("leaves a self-consumption premium over importing", () => {
    const premium = allInPrice(0.08, markup) - feedInPrice(0.08, markup);
    expect(premium).toBeCloseTo(0.1316, 4);
  });

  it("stays below the import price at every raw price", () => {
    // The engine ranks surplus slots ahead of every grid hour on the strength of this,
    // so it must hold across the whole range, negative prices included.
    for (const raw of [-0.5, -0.05, 0, 0.05, 0.4, 2]) {
      expect(feedInPrice(raw, markup)).toBeLessThan(allInPrice(raw, markup) + 1e-9);
    }
  });

  it("goes negative when the market price does — exporting then costs money", () => {
    // Deliberately not clamped at 0: this is exactly when diverting surplus into the car
    // is worth the most, and clamping would hide that from the engine.
    expect(feedInPrice(-0.05, markup)).toBeCloseTo(-0.0363, 4);
  });

  it("deducts the fee instead when it is configured negative", () => {
    // (0.08 - 0.02) * 1.21
    expect(feedInPrice(0.08, { ...markup, feedInFeePerKwh: -0.02 })).toBeCloseTo(0.0726, 4);
  });

  it("skips VAT when the contract doesn't apply it", () => {
    expect(feedInPrice(0.08, { ...markup, feedInInclVat: false })).toBeCloseTo(0.1, 4);
  });

  it("returns the flat rate on a fixed contract, ignoring the market", () => {
    const fixed = { ...markup, feedInBasis: "fixed", feedInTariffPerKwh: 0.07 };
    expect(feedInPrice(0.8, fixed)).toBe(0.07);
    expect(feedInPrice(-0.2, fixed)).toBe(0.07);
  });
});
