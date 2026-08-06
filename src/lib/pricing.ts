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
