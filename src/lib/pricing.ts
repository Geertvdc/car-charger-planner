export interface PriceMarkup {
  energyTaxPerKwh: number;
  supplierFeePerKwh: number;
  vatRate: number;
}

/**
 * Dutch dynamic-tariff all-in consumer price:
 *   (rawMarket + energyTax + supplierFee) * (1 + VAT)
 * Raw market price can be negative; all-in is clamped at 0 (you don't get paid to consume).
 */
export function allInPrice(rawPrice: number, m: PriceMarkup): number {
  const net = (rawPrice + m.energyTaxPerKwh + m.supplierFeePerKwh) * (1 + m.vatRate);
  return Math.max(0, Math.round(net * 10000) / 10000);
}

export interface FeedInMarkup {
  feedInBasis: string; // "market" | "fixed"
  feedInFeePerKwh: number; // added to the raw price; negative if your supplier deducts it
  feedInInclVat: boolean;
  feedInTariffPerKwh: number; // the flat rate, used when feedInBasis is "fixed"
  vatRate: number;
}

/**
 * What you actually *receive* per kWh exported to the grid.
 *
 * Deliberately asymmetric with allInPrice(): the energy tax is a consumption tax, so
 * exporting never refunds it. That gap — typically ~0.13 EUR/kWh — is the whole reason
 * to divert surplus PV into the car instead of feeding it back.
 *
 * Also deliberately *not* clamped at 0. When the raw market price goes negative,
 * exporting costs you money, which is precisely when self-consumption is worth the most;
 * clamping here would hide that from the engine's ranking.
 */
export function feedInPrice(rawPrice: number, m: FeedInMarkup): number {
  if (m.feedInBasis === "fixed") return m.feedInTariffPerKwh;
  const net = (rawPrice + m.feedInFeePerKwh) * (m.feedInInclVat ? 1 + m.vatRate : 1);
  return Math.round(net * 10000) / 10000;
}
