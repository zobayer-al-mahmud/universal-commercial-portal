/**
 * SANITIZED SYNTHETIC FIXTURE — not real H&M / Ananta data.
 *
 * The source material set contained Order Package .msg containers but no
 * standalone, machine-readable Purchase Order PDFs, so no real PO text could be
 * extracted. This fixture reproduces the labelled pdftotext-style layout that
 * SRS §C.3 describes, using format-valid but fictional values, so the parser and
 * pipeline can be tested deterministically. Order numbers / prices are invented.
 */

export const SAMPLE_PO_SINGLE_MARKET = `
PO Number: 644923-5672
Style Name: Regular LP S4
Article: 1234567
Category: Trousers
Customer Group: Men
Construction: Woven
Season: 3-2026
Order Date: 09 Jun, 2026
Terms of Delivery: FCA
Transport By: Sea
Currency: USD
No of Pieces: 1

Market  Group  Qty  Price  TOD
OW (OL-MX) 2000 12.64 09 Jun, 2026
`;

export const SAMPLE_PO_MULTI_MARKET_EQUAL = `
PO Number: 644637-8756
Style Name: Slim Denim S4
Article: 7654321
Category: Trousers
Customer Group: Women
Construction: Woven
Season: 2-2026
Order Date: 09 Jun, 2026
Terms of Delivery: FCA
Transport By: Sea
Currency: USD

OW (OL-MX) 1000 10.50 09 Jun, 2026
CL (PM-CL) 1500 10.50 09 Jun, 2026
`;

// Per-market prices differ by a cent (triggers Q-SC-01 pending decision).
export const SAMPLE_PO_PRICE_DIVERGENCE = `
PO Number: 649397-5672
Style Name: New Loose MP Jeans S4
Article: 1112223
Category: Trousers
Customer Group: Men
Construction: Woven
Season: 3-2026
Order Date: 09 Jun, 2026
Currency: USD

OW (OL-MX) 500 6.34 09 Jun, 2026
CL (PM-CL) 700 6.36 11 Jun, 2026
`;

// Invalid OrderNo (fails ^\d{6,7}-\d{3,4}$) -> hard queue.
export const SAMPLE_PO_BAD_ORDER = `
PO Number: 99-9
Style Name: Bad Order
Customer Group: Men
Construction: Woven
Currency: USD

OW (OL-MX) 100 5.00 09 Jun, 2026
`;
