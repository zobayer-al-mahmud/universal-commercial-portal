import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { patchTemplate } from '../src/server/customs-invoice/zip-write';
import type { InvoiceFields } from '../src/server/customs-invoice/types';

const BASE: InvoiceFields = {
  invoiceNumber: "TEST", invoiceDate: "28.12.2025",
  contractNo: "AGL/H&M/97/2025", contractDate: "06.07.2025", hmOrderNo: "498160/8757",
  marketCode: "NH", marketSubCode: "NH", countryCode: "NH", expNo: "31074", expDate: "28.12.2025",
  portOfLoading: "", portOfDischarge: "", placeOfDelivery: "", countryOfOrigin: "", countryOfFinalDestination: "",
  transportMode: "", termsOfDelivery: "", termsOfPayment: "", vesselName: "", voyageNo: "", sailingDate: "",
  currency: "USD", exporterName: "", buyerName: "", consigneeName: "", cargoDeliveryName: "", issuingBank: "",
  descriptionOfGoods: "", styleNo: "", buyerCode: "", hsCode: "", category: "",
  quantityPcs: 10, unitPrice: 7.26, totalCartons: 1, grossWeightKg: 5.82, netWeightKg: 5.06, measurementCbm: null,
  dimension: "", packSet: "",
};
const r = await patchTemplate('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx', BASE);
console.log('result:', r);
