/**
 * HTML injection module for Mailchimp template generation.
 *
 * Exports:
 *   generateMailchimpHTML(masterHtml, products, selectedFields) -> string
 *   getTemplateName(products)                                   -> string
 *
 * Error contract: throws Error with .code on structural failures.
 *
 * SECURITY:
 *   - All product text is passed through escHtml() then neutralizeMergeTags()
 *   - All URLs are validated (https:// only) then HTML-attribute-escaped
 *   - All .replace() calls use function replacers to prevent $-special behavior
 *   - Section markers wrap full <tr> rows -- never single <td> cells
 */

"use strict";

// ---------------------------------------------------------------------------
// Security utilities
// ---------------------------------------------------------------------------

/** HTML-escape the 5 special characters. Always call this BEFORE neutralizeMergeTags. */
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Neutralize Mailchimp merge tags AFTER HTML-escaping.
 * *|TAG|* -> *&#124;TAG&#124;*
 * Visible text: *|TAG|*  (plain, not a merge tag)
 * HTML source:  *&#124;TAG&#124;*
 *
 * NOTE: escHtml does NOT escape * or |, so this operates on the correct chars.
 * Reverse order would double-encode: &#124; -> &amp;#124; (broken).
 */
function neutralizeMergeTags(str) {
  return str.replace(/\*\|/g, () => "*&#124;");
}

/** Safe display text: HTML-escape first, then neutralize merge tags. */
function safe(v) {
  return neutralizeMergeTags(escHtml(String(v || "")));
}

/**
 * Validate a URL -- https:// only.
 * http:// and anything else returns "#".
 * URL.href normalizes the URL (e.g. encodes spaces).
 */
function safeUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:") return "#";
    return u.href;
  } catch (_) {
    return "#";
  }
}

/**
 * Validate an image URL -- https:// only.
 * Returns the normalized URL string, or null on failure.
 */
function safeImageUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" ? u.href : null;
  } catch (_) {
    return null;
  }
}

/**
 * URL safe for an HTML attribute: validate protocol, then HTML-escape
 * so that & -> &amp; in href/src context.
 */
function safeAttr(url) {
  return escHtml(safeUrl(String(url || "")));
}

// ---------------------------------------------------------------------------
// Section removal
// ---------------------------------------------------------------------------

/**
 * Remove a complete <!-- SECTION_X_START --> ... <!-- SECTION_X_END --> block.
 * The markers must wrap full <tr> rows (not individual <td> cells) so that
 * removing a section never breaks the email table column count.
 *
 * Uses a function replacer to prevent $ in content from causing issues
 * (though the block is removed entirely, so this is belt-and-suspenders).
 */
function removeSection(html, sectionId) {
  const re = new RegExp(
    `<!-- SECTION_${sectionId}_START -->[\\s\\S]*?<!-- SECTION_${sectionId}_END -->`,
    "g"
  );
  return html.replace(re, () => "");
}

// ---------------------------------------------------------------------------
// Data formatting
// ---------------------------------------------------------------------------

/**
 * Format units: strip non-digit/dot characters, parse as Number, format with
 * locale commas. Falls back to the raw units string if Number() returns NaN.
 * Returns null if units is empty/null.
 *
 * Examples:
 *   "1,200"       -> "1,200"
 *   "500 Units"   -> "500"
 *   "2400"        -> "2,400"
 *   null / ""     -> null  (section will be removed)
 */
function formatUnits(units) {
  if (!units) return null;
  const stripped = String(units).replace(/[^\d.]/g, "");
  const num = Number(stripped);
  if (!isNaN(num) && stripped.length > 0) {
    return num.toLocaleString("en-US");
  }
  // NaN fallback: use the raw string (better than removing the section)
  return String(units);
}

/**
 * Display price = ONLY the price typed in the Telegram message (e.g. "$23").
 * The scraped Amazon/Walmart retail price is deliberately NOT used here: it is
 * the retail price, not the deal price, and must never appear as the deal price
 * in an email. When no price was typed the PRICE row is removed.
 */
function resolvePrice(price /* , scrapedPrice (ignored) */) {
  return price ? String(price) : null;
}

// ---------------------------------------------------------------------------
// Subject line + master file
// ---------------------------------------------------------------------------

/**
 * Campaign subject, e.g.
 *   1 product : "\u{1F6A8}HILL'S PRESCRIPTION DIET @ $23/unit | 364 Units"
 *   N products: "\u{1F6A8}CLOSEOUT DEALS | 3 Products"
 */
function buildSubject(products) {
  const siren = "\u{1F6A8}";
  if (!products || products.length === 0) return `${siren}CLOSEOUT DEALS`;
  if (products.length > 1) return `${siren}CLOSEOUT DEALS | ${products.length} Products`;

  const p = products[0];
  const brand = String(p.brand || p.name || "Closeout Deal").trim().toUpperCase();
  const priceStr = p.price ? ` @ ${p.price}/unit` : "";
  const fmt = formatUnits(p.units);
  const unitsStr = fmt ? ` | ${fmt} Units` : "";
  return `${siren}${brand}${priceStr}${unitsStr}`.slice(0, 150);
}

/** Reads the master email HTML that ships with the project. */
function loadMasterHtml() {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", "templates", "master.html");
  try {
    const html = fs.readFileSync(file, "utf8");
    if (!html || html.length < 100) throw new Error("empty");
    return html;
  } catch (e) {
    const err = new Error(`Master email file not readable (${file}): ${e.message}`);
    err.code = "master_file_missing";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Template name
// ---------------------------------------------------------------------------

/**
 * Generate a unique template name:
 *   "Brand — 3 Products — 2026-10-02 13:45:07 A3F1"
 *
 * Uses seconds-precision timestamp + 4-char random suffix so two requests
 * in the same second still get different names.
 */
function getTemplateName(products) {
  const brand = (products[0] && (products[0].brand || products[0].name)) || "Closeout Deal";
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return products.length === 1
    ? `${brand} -- ${ts} ${rand}`
    : `Closeout Deals -- ${products.length} Products -- ${ts} ${rand}`;
}

// ---------------------------------------------------------------------------
// Core injection
// ---------------------------------------------------------------------------

/**
 * Inject one product's data into a block of HTML (the repeatable product block).
 *
 * Steps:
 *   1. Remove disabled or empty sections (full <tr> blocks)
 *   2. Replace PLACEHOLDER_* markers using function replacers ($ safe)
 *
 * @param {string} blockHtml         - HTML of the repeatable product block
 * @param {object} product           - Merged parser + scraper product object
 * @param {Set<string>} sel          - Set of enabled Firestore field keys
 * @returns {string}
 */
function injectProductData(blockHtml, product, sel) {
  let html = blockHtml;

  const {
    name, brand, image, price, scrapedPrice,
    units, upc, asin, url, exp, fob, moq, condition,
  } = product;

  const effectivePrice = resolvePrice(price, scrapedPrice);
  const fmtUnits = formatUnits(units);
  const validImage = safeImageUrl(image); // null if not https://

  // --- 1. Remove disabled (Firestore toggle) or empty sections ---
  // Each call removes the full <tr> block between the section markers.
  if (!sel.has("image") || !validImage) html = removeSection(html, "IMAGE");
  if (!sel.has("name") || !name) html = removeSection(html, "NAME");
  if (!sel.has("price") || !effectivePrice) html = removeSection(html, "PRICE");
  if (!sel.has("units") || !fmtUnits) html = removeSection(html, "UNITS");
  // UPC: always show when field is enabled — display "N/A" if no data
  if (!sel.has("upc")) html = removeSection(html, "UPC");
  if (!sel.has("link") || !url) html = removeSection(html, "LINK");

  // Data-presence-controlled (no Firestore toggle -- show when data present)
  if (!brand) html = removeSection(html, "BRAND");
  // EXP: always show — display "N/A" if no data
  if (!fob) html = removeSection(html, "FOB");
  if (!moq) html = removeSection(html, "MOQ");
  if (!condition) html = removeSection(html, "CONDITION");
  if (!asin) html = removeSection(html, "ASIN");

  // --- 2. Inject values using function replacers ---
  // Function replacers prevent $ in product data (e.g. prices) from being
  // interpreted as JavaScript replacement patterns ($1, $&, $', etc.).
  html = html
    .replace(/PLACEHOLDER_NAME/g, () => safe(name))
    .replace(/PLACEHOLDER_BRAND/g, () => safe(brand))
    .replace(/PLACEHOLDER_PRICE/g, () => safe(effectivePrice))
    .replace(/PLACEHOLDER_UNITS/g, () => safe(fmtUnits))
    .replace(/PLACEHOLDER_UPC/g, () => safe(upc || "N/A"))
    .replace(/PLACEHOLDER_ASIN/g, () => safe(asin))
    .replace(/PLACEHOLDER_EXP/g, () => safe(exp || "N/A"))
    .replace(/PLACEHOLDER_FOB/g, () => safe(fob))
    .replace(/PLACEHOLDER_MOQ/g, () => safe(moq))
    .replace(/PLACEHOLDER_CONDITION/g, () => safe(condition))
    .replace(/PLACEHOLDER_URL/g, () => safeAttr(url))
    .replace(/PLACEHOLDER_IMAGE/g, () => safeAttr(image));

  return html;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate the final Mailchimp template HTML by:
 *   1. Extracting the repeatable PRODUCT_BLOCK from the master HTML
 *   2. Cloning the block once per product (same design, different data)
 *   3. Reassembling the full HTML with N product blocks in place of the original 1
 *
 * @param {string}   masterHtml      - Full HTML of the master template
 * @param {object[]} products        - Array of merged product objects (successful scrapes only)
 * @param {string[]} selectedFields  - Array of enabled Firestore field keys
 * @returns {string} Final HTML ready to POST to Mailchimp
 * @throws {Error}  err.code = "marker_missing" if PRODUCT_BLOCK markers are absent
 */
function generateMailchimpHTML(masterHtml, products, selectedFields) {
  const blockRegex = /<!-- PRODUCT_BLOCK_START -->([\s\S]*?)<!-- PRODUCT_BLOCK_END -->/;
  const blockMatch = masterHtml.match(blockRegex);

  if (!blockMatch) {
    const err = new Error(
      "Master email is missing <!-- PRODUCT_BLOCK_START --> / <!-- PRODUCT_BLOCK_END --> markers. " +
      "Check routing/templates/master.html."
    );
    err.code = "marker_missing";
    throw err;
  }

  const blockTemplate = blockMatch[1];
  const sel = new Set(selectedFields);

  // Generate one HTML block per product (same master design, different data)
  const productBlocks = products.map((p) => injectProductData(blockTemplate, p, sel));

  // Replace the single master block with N product blocks.
  // Function replacer prevents any $ in productBlocks content from being misread.
  return masterHtml.replace(
    blockRegex,
    () => productBlocks.join("\n<!-- PRODUCT_DIVIDER -->\n")
  );
}

module.exports = {
  generateMailchimpHTML,
  getTemplateName,
  buildSubject,
  loadMasterHtml,
  // Exported for testing
  escHtml,
  neutralizeMergeTags,
  safe,
  safeUrl,
  safeImageUrl,
  safeAttr,
  removeSection,
  formatUnits,
  resolvePrice,
};
