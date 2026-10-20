/** Public barrel for the H&M Sales Contract pure-logic module. */
export * from "./types";
export { parsePurchaseOrderText } from "./parse-po";
export { parseSizeBreakdownText } from "./parse-size-breakdown";
export { parseCountryBreakdownText } from "./parse-country-breakdown";
export { matchSet } from "./match";
export { reconcileSet } from "./validate";
export { mapToTemplateRows, buildSetResult, buildItemDes, formatQtySpaced } from "./map-to-rows";
export { writeSalesContractWorkbook } from "./write-xlsx";
export type { HmWriteOptions, HmWriteResult, HmFlatCells } from "./write-xlsx";
