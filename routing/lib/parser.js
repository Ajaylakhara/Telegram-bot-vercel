/**
 * Parses a raw Telegram message that may contain one or more product listings
 * in flexible free-text formats (same-line, multi-line, shared/global price,
 * per-product price, optional Exp / FOB lines).
 *
 * Returns an array of { url, units, price, exp, fob, moq, condition } objects,
 * one per product URL found in the message.
 * moq and condition are null when not present in the message.
 */
function parseMultiProduct(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // A standalone price line requires a "$" prefix OR explicit "per unit" text,
  // to avoid matching bare unit counts like "2400" as a price.
  // NOTE: "Asking Price - $X" is intentionally excluded here — it's an
  // inventory-level total, not a per-product unit price. See inventory.js.
  const isStandalonePrice = (line) =>
    /^\$\s*\d+(\.\d+)?(\s+per\s*unit)?$/i.test(line) ||
    /^\d+(\.\d+)?\s+per\s*unit$/i.test(line) ||
    /^price\s*:?\s*\$?\s*\d+(\.\d+)?$/i.test(line);

  const extractPrice = (line) => {
    const m = line.match(/\$?\s*([\d,]+(\.[\d]+)?)/);
    if (!m) return null;
    const num = m[1].replace(/,/g, "");
    return `$${num}`;
  };

  // Identify URL line indices
  const urlLineIndices = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (/https?:\/\/\S+/.test(lines[i])) urlLineIndices.add(i);
  }

  // A standalone price on the line IMMEDIATELY after a URL belongs to that
  // specific product only — must NOT be treated as a shared global price.
  const perProductPriceIndices = new Set();
  for (const ui of urlLineIndices) {
    if (ui + 1 < lines.length && isStandalonePrice(lines[ui + 1])) {
      perProductPriceIndices.add(ui + 1);
    }
  }

  // Global/shared price: a standalone price line NOT adjacent to any URL.
  // Handles "one price at the bottom applies to all products".
  let globalPrice = null;
  for (let i = 0; i < lines.length; i++) {
    if (
      !urlLineIndices.has(i) &&
      !perProductPriceIndices.has(i) &&
      isStandalonePrice(lines[i])
    ) {
      globalPrice = extractPrice(lines[i]);
      break;
    }
  }

  const products = [];
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/https?:\/\/\S+/);
    if (!urlMatch) continue;

    const url = urlMatch[0];
    let units = null;
    let price = null; // start null; fall back to globalPrice only at the end
    let exp = null;
    let fob = null;
    let moq = null;
    let condition = null;

    // Same-line format: "url $27 600 Units Available"
    const sameLineUnits = lines[i].match(/([\d,]+)\s*Units/i);
    const sameLinePrice = lines[i].match(/\$(\d+(\.\d+)?)/);
    if (sameLineUnits) units = sameLineUnits[1].replace(/,/g, "");
    if (sameLinePrice) price = `$${sameLinePrice[1]}`;

    // Scan the next up to 5 lines for per-product data; stop at next URL.
    for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
      if (urlLineIndices.has(j)) break;
      const line = lines[j];

      if (!units) {
        const m = line.match(/([\d,]+)\s*Units/i);
        if (m) units = m[1].replace(/,/g, "");
      }

      if (!price && !sameLinePrice && isStandalonePrice(line)) {
        price = extractPrice(line);
      }

      if (!exp) {
        const m = line.match(/^Exp\.?\s*:?\s*(.+)/i);
        if (m) exp = m[1].trim();
      }

      if (!fob) {
        const m = line.match(/^FOB\s*:?\s*(.+)/i);
        if (m) fob = m[1].trim();
      }

      if (!moq) {
        const m = line.match(/^(?:MOQ|Min\.?\s*Order|Minimum)\s*:?\s*([\d,]+)/i);
        if (m) moq = m[1].replace(/,/g, "");
      }

      if (!condition) {
        const m = line.match(/^Condition\s*:?\s*(.+)/i);
        if (m) condition = m[1].trim();
      }
    }

    if (!price) price = globalPrice;

    products.push({ url, units, price, exp, fob, moq, condition });
  }
  return products;
}

module.exports = { parseMultiProduct };