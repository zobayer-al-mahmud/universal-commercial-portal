// `@types/pdf-parse` only types the package root. We import `pdf-parse/lib/pdf-parse.js`
// directly (the root index.js runs a debug file-read branch under bundlers/test runners),
// so re-export the same types for that deep path.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdf from "pdf-parse";
  export default pdf;
}
