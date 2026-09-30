// ---------- Field definitions per mode ----------
const MODE_FIELDS = {
  mail: ["subject", "name", "price", "units", "upc", "link", "image"],
  linkedin: ["upc", "price", "units", "link", "image"],
  website: ["name", "price", "units", "upc", "asin", "link", "image"],
};

const FIELD_LABELS = {
  subject: "Subject",
  name: "Product Name",
  price: "Price",
  units: "Units",
  upc: "UPC",
  asin: "ASIN",
  link: "Link",
  image: "Image",
};

/** Builds the inline keyboard for the field-selection menu of a given mode. */
function buildFieldKeyboard(mode, selectedFields) {
  const fields = MODE_FIELDS[mode] || [];
  const selected = new Set(selectedFields);
  const rows = [];

  for (let i = 0; i < fields.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, fields.length); j++) {
      const f = fields[j];
      const check = selected.has(f) ? "✅" : "⬜";
      row.push({ text: `${check} ${FIELD_LABELS[f]}`, callback_data: `field:${f}` });
    }
    rows.push(row);
  }

  const allSelected = fields.every((f) => selected.has(f));
  rows.push([
    allSelected
      ? { text: "⬜ None", callback_data: "toggle_all" }
      : { text: "☑️ All", callback_data: "toggle_all" },
  ]);

  rows.push([
    { text: "↩️ Change Mode", callback_data: "change_mode" },
    { text: "✔️ Done", callback_data: "fields_done" },
  ]);

  return { inline_keyboard: rows };
}

/**
 * Builds the reply text for a scraped product, respecting the user's
 * per-mode field selection. Fields not in `selectedFields` are omitted
 * entirely (not shown as "N/A").
 */
function formatCaption(mode, product, selectedFields) {
  const { name, brand, price, units, upc, asin, url, exp, fob } = product;
  const fmtUnits = units ? Number(units).toLocaleString("en-US") : null;

  const sel = selectedFields && selectedFields.length > 0
    ? new Set(selectedFields)
    : new Set(MODE_FIELDS[mode] || []);

  const lines = [];

  if (mode === "mail") {
    if (sel.has("subject")) {
      const subjectName = brand || name || "Product";
      lines.push(`Subject: ${subjectName} @ ${price || "N/A"}/unit | ${fmtUnits || "N/A"} Units`);
      lines.push("");
    }
    if (sel.has("name")) lines.push(`Product: ${name || "N/A"}`);
    if (sel.has("price")) lines.push(`Price: ${price || "N/A"}`);
    if (sel.has("units")) lines.push(`Units: ${fmtUnits || "N/A"}`);
    if (sel.has("units") || sel.has("price")) {
      if (exp) lines.push(`Exp: ${exp}`);
      if (fob) lines.push(`FOB: ${fob}`);
    }
    if (sel.has("upc")) lines.push(`UPC: ${upc || "N/A"}`);
    if (sel.has("link")) lines.push(`Link: ${url}`);
    return lines.join("\n");
  }

  if (mode === "website") {
    if (sel.has("name")) lines.push(`Name: ${name || "N/A"}`);
    if (sel.has("price")) lines.push(`Price: ${price || "N/A"}`);
    if (sel.has("units")) lines.push(`Units: ${fmtUnits || "N/A"}`);
    if (sel.has("units") || sel.has("price")) {
      if (exp) lines.push(`Exp: ${exp}`);
      if (fob) lines.push(`FOB: ${fob}`);
    }
    if (sel.has("upc")) lines.push(`UPC: ${upc || "N/A"}`);
    if (sel.has("asin")) lines.push(`ASIN: ${asin || "N/A"}`);
    if (sel.has("link")) lines.push(`Link: ${url}`);
    return lines.join("\n");
  }

  // linkedin mode
  if (sel.has("upc")) lines.push(`UPC: ${upc || "N/A"}`);
  if (sel.has("price")) lines.push(`Price: ${price || "N/A"}`);
  if (sel.has("units")) lines.push(`Units: ${fmtUnits || "N/A"}`);
  if (sel.has("units") || sel.has("price")) {
    if (exp) lines.push(`Exp: ${exp}`);
    if (fob) lines.push(`FOB: ${fob}`);
  }
  if (sel.has("link")) lines.push(`Link: ${url}`);
  return lines.join("\n");
}

module.exports = { MODE_FIELDS, FIELD_LABELS, buildFieldKeyboard, formatCaption };