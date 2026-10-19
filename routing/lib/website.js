/**
 * Flow 6: Publish to Website
 *
 * Handles the full "Website mode → scrape → preview → pick category →
 * publish" pipeline against the Laravel API at process.env.SITE_URL.
 *
 * Firestore collection: sitePending/{chatId}
 * Shape: { products, categoryId, processing, processingAt, createdAt }
 *
 * Lock pattern is identical to mailchimpFlow.js (transaction → processing flag).
 */

"use strict";

const { db } = require("./firebase");
const { sendMessage, sendPhoto, sendPhotoBuffer, editMessageText, editMessageReplyMarkup } = require("./telegram");
const { squareImage, sendSquarePhoto } = require("./image");
const { scrapeProduct, sleep } = require("./scraper");
const { MODE_FIELDS, formatCaption } = require("./format");

// ---------------------------------------------------------------------------
// Constants — change these to update every product's fixed fields at once
// ---------------------------------------------------------------------------
const PRODUCT_CONSTANTS = {
  condition:   "New",
  lead_time:   "3-4 Days",
  packaging:   "Retail Packaging",
  status:      "inactive",
  auto_delete: "false",
};

// Max products published concurrently
const PUBLISH_CONCURRENCY = 3;

// Session TTL: sessions older than this are considered expired (30 min)
const SESSION_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Utility: check env
// ---------------------------------------------------------------------------
function siteConfigured() {
  return !!(
    (process.env.SITE_URL || "").trim() &&
    (process.env.SITE_API_SECRET || "").trim()
  );
}

// ---------------------------------------------------------------------------
// Utility: normalise number strings
// "$14.50" → 14.5,  "2,400 Units" → 2400
// ---------------------------------------------------------------------------
function normaliseNumber(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).replace(/[^0-9.]/g, "");
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function normaliseInt(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).replace(/[^0-9]/g, "");
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Utility: expiry date  MM/YYYY → YYYY-MM-DD (last day of month)
// ---------------------------------------------------------------------------
function parseExpDate(exp) {
  if (!exp) return null;
  const s = String(exp).trim();

  // MM/YYYY or MM-YYYY (e.g. 06/2027)
  let m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const year  = parseInt(m[2], 10);
    if (month < 1 || month > 12 || year < 2000) return null;
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }

  // MM/YY or MM-YY (e.g. 06/27 → 2027-06-30)
  m = s.match(/^(\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const year  = 2000 + parseInt(m[2], 10);
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Utility: decide amz_link / walmart_link from URL
// ---------------------------------------------------------------------------
function classifyUrl(url) {
  if (!url) return {};
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("walmart.com")) return { walmart_link: url };
    if (host.includes("amazon.com") || host.includes("a.co") || host.includes("amzn.to"))
      return { amz_link: url };
  } catch (_) { /* ignore */ }
  return {};
}

// ---------------------------------------------------------------------------
// getCategories(): GET /api/bot/categories
// Returns raw array from Laravel; throws on error.
// ---------------------------------------------------------------------------
async function getCategories() {
  const base   = (process.env.SITE_URL || "").replace(/\/$/, "");
  const secret = process.env.SITE_API_SECRET || "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${base}/api/bot/categories`, {
      headers: { "x-api-key": secret },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
    }
    return await res.json(); // flat array of { id, name, parent_id, is_package_deal }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// publishToSite(product, categoryId):
// POST multipart/form-data to /api/bot/products
// Returns { ok: bool, status: number, body: object }
// ---------------------------------------------------------------------------
async function publishToSite(product, categoryId) {
  const base   = (process.env.SITE_URL || "").replace(/\/$/, "");
  const secret = process.env.SITE_API_SECRET || "";

  const form = new FormData();

  // --- Required fields ---
  form.append("name",        product.name);
  form.append("category_id", String(categoryId));

  const priceUnit = normaliseNumber(product.price);
  if (priceUnit !== null) form.append("price_unit", String(priceUnit));

  const qty = normaliseInt(product.units);
  if (qty !== null) form.append("quntity", String(qty));

  // --- Constants ---
  for (const [k, v] of Object.entries(PRODUCT_CONSTANTS)) {
    form.append(k, v);
  }

  // --- Optional fields (omit if empty/null) ---
  const retailPrice = product.scrapedPrice;
  if (retailPrice !== null && retailPrice !== undefined) {
    form.append("retail_price", String(retailPrice));
  }

  if (product.brand && String(product.brand).trim()) {
    form.append("brand", String(product.brand).trim());
  }

  if (product.fob && String(product.fob).trim()) {
    form.append("location", String(product.fob).trim());
  }

  if (product.asin && String(product.asin).trim()) {
    form.append("asin_no", String(product.asin).trim());
  }

  if (product.upc && String(product.upc).trim()) {
    form.append("upc", String(product.upc).trim());
  }

  const moqInt = normaliseInt(product.moq);
  if (moqInt !== null) {
    form.append("minimum_quntity", String(moqInt));
  }

  const expDate = parseExpDate(product.exp);
  if (expDate) {
    form.append("expiration_date", expDate);
  }

  // URL routing: amazon vs walmart
  const linkFields = classifyUrl(product.url);
  for (const [k, v] of Object.entries(linkFields)) {
    form.append(k, v);
  }

  // Image: use the pre-built _sq buffer if present, else skip
  if (product._sq && Buffer.isBuffer(product._sq)) {
    const blob = new Blob([product._sq], { type: "image/jpeg" });
    form.append("image", blob, "product.jpg");
  }

  // --- POST ---
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    // Never log the API secret or full body
    console.log(`[site] POST product: "${product.name}" cat=${categoryId}`);

    const res = await fetch(`${base}/api/bot/products`, {
      method: "POST",
      headers: { "x-api-key": secret },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.json().catch(() => ({}));
    return { ok: res.status === 201, status: res.status, body };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { ok: false, status: 0, body: { message: "timeout" } };
    }
    console.error("[site] publishToSite network error:", err.message);
    return { ok: false, status: 0, body: { message: err.message } };
  }
}

// ---------------------------------------------------------------------------
// Build category inline keyboard (flat list → two-level tree)
// callback_data patterns: site_cat:12  site_back:0  site_page:1:{parentId}
// All under 64 bytes.
// ---------------------------------------------------------------------------
const PAGE_SIZE = 15; // max buttons per page (excluding nav buttons)

function buildCategoryKeyboard(categories, parentId = null, page = 0, productCount = 1) {
  // Children of parentId (null = top-level)
  const siblings = categories.filter((c) => c.parent_id === parentId);
  const start    = page * PAGE_SIZE;
  const slice    = siblings.slice(start, start + PAGE_SIZE);
  const hasNext  = siblings.length > start + PAGE_SIZE;
  const hasPrev  = page > 0;

  const rows = [];

  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, slice.length); j++) {
      const cat = slice[j];
      const hasChildren = categories.some((c) => c.parent_id === cat.id);
      // Show ▶ if the category has children (tapping it drills down)
      const label = hasChildren ? `${cat.name} ▶` : cat.name;
      row.push({
        text: label,
        callback_data: `site_cat:${cat.id}`,
      });
    }
    rows.push(row);
  }

  // Pagination row
  const navRow = [];
  if (hasPrev) navRow.push({ text: "⬅️ Prev",  callback_data: `site_page:${page - 1}:${parentId ?? 0}` });
  if (hasNext) navRow.push({ text: "➡️ Next",  callback_data: `site_page:${page + 1}:${parentId ?? 0}` });
  if (navRow.length) rows.push(navRow);

  // Back button when drilling into a child
  if (parentId !== null) {
    const parent = categories.find((c) => c.id === parentId);
    const grandparentId = parent ? parent.parent_id : null;
    rows.push([{
      text: "⬅️ Back",
      callback_data: `site_back:${grandparentId ?? 0}`,
    }]);
  }

  // "Use same category for all" shortcut — visible only for multi-product sessions
  // at the top-level picker so user knows one choice covers every product.
  if (productCount > 1 && parentId === null) {
    rows.push([{
      text: `✅ Use same category for all (${productCount} products)`,
      callback_data: "site_same_for_all",
    }]);
  }

  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Confirm keyboard (shown after category is chosen)
// ---------------------------------------------------------------------------
function buildConfirmKeyboard(hasRequired) {
  const publishBtn = hasRequired
    ? { text: "✅ Post to Website",         callback_data: "site_confirm" }
    : { text: "🚫 Post (missing fields)",  callback_data: "site_confirm_blocked" };

  return {
    inline_keyboard: [
      [publishBtn],
      [
        { text: "🔁 Change Category", callback_data: "site_change" },
        { text: "❌ Cancel",           callback_data: "site_cancel"  },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Check required fields on a product
// ---------------------------------------------------------------------------
function missingRequired(product) {
  const missing = [];
  if (!product.name || !String(product.name).trim())         missing.push("name");
  if (!product.price || normaliseNumber(product.price) === null) missing.push("price");
  if (!product.units || normaliseInt(product.units) === null) missing.push("units");
  return missing;
}

// ---------------------------------------------------------------------------
// STEP 1  sitePreviewFlow — called from webhook.js after cards are sent
// ---------------------------------------------------------------------------
async function sitePreviewFlow(chatId, scrapedProducts) {
  if (!siteConfigured()) return; // Website mode still works, Publish is just silent

  try {
    // 1. Save to sitePending — IMPORTANT: strip _sq Buffer (not Firestore-serialisable)
    const productsForStore = scrapedProducts.map((p) => {
      // eslint-disable-next-line no-unused-vars
      const { _sq, ...rest } = p;
      return rest;
    });

    const pendingRef = db.collection("sitePending").doc(String(chatId));
    await pendingRef.set({
      products:     productsForStore,
      categoryId:   null,
      processing:   false,
      processingAt: 0,
      createdAt:    Date.now(),
    });

    // 2. Fetch categories
    let categories;
    try {
      categories = await getCategories();
    } catch (err) {
      console.error("[site] getCategories failed:", err.message);
      await sendMessage(chatId, "⚠️ Could not load categories from the website. Please try again later.");
      return;
    }

    if (!Array.isArray(categories) || categories.length === 0) {
      await sendMessage(chatId, "⚠️ No categories returned from the website.");
      return;
    }

    // 3. Store categories in the pending doc (to rebuild keyboard in callbacks)
    await pendingRef.update({ categories });

    // 4. Show category picker
    const count = scrapedProducts.length;
    const keyboard = buildCategoryKeyboard(categories, null, 0, count);
    await sendMessage(
      chatId,
      `📂 Select a category for ${count} product(s):`,
      { reply_markup: keyboard }
    );
  } catch (err) {
    console.error("[SITE_PREVIEW] error:", err.message);
    await sendMessage(chatId, "❌ Something went wrong starting the website flow. Please try again.").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// STEP 2  publishSiteFlow — called from callbacks.js on site_confirm
// ---------------------------------------------------------------------------
async function publishSiteFlow(chatId) {
  if (!siteConfigured()) {
    await sendMessage(chatId, "⚠️ Website publishing is not configured. Ask the admin to set SITE_URL and SITE_API_SECRET.");
    return false;
  }

  const pendingRef = db.collection("sitePending").doc(String(chatId));

  // Atomic claim (mirrors mailchimpFlow.js)
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (!snap.exists) return { state: "missing" };
    const d = snap.data();

    // Session expiry
    if (Date.now() - (d.createdAt || 0) > SESSION_TTL_MS) return { state: "expired" };

    // Double-tap guard (120 s staleness)
    if (d.processing && Date.now() - (d.processingAt || 0) < 120000) return { state: "busy" };

    tx.update(pendingRef, { processing: true, processingAt: Date.now() });
    return { state: "ok", data: d };
  });

  if (claim.state === "missing" || claim.state === "expired") {
    await sendMessage(chatId, "⏳ Session expired, please send the links again.");
    return false;
  }
  if (claim.state === "busy") {
    await sendMessage(chatId, "⏳ Already publishing. Please wait a moment.");
    return false;
  }

  const { products, categoryId, categories } = claim.data;

  // Validate required fields across all products
  const allMissingRequired = products.every((p) => missingRequired(p).length > 0);
  if (!categoryId) {
    await sendMessage(chatId, "❌ No category selected. Please pick a category first.");
    await pendingRef.update({ processing: false }).catch(() => {});
    return false;
  }

  // Re-prepare _sq buffers (they're not stored in Firestore)
  await Promise.all(
    products.map(async (p) => {
      if (!p._sq && p.image && typeof p.image === "string" && p.image.startsWith("http")) {
        p._sq = await squareImage(p.image).catch(() => null);
      }
    })
  );

  try {
    await sendMessage(chatId, `🌐 Publishing ${products.length} product(s) to the website… please wait.`);

    const successes = [];
    const failures  = [];

    // Max 3 concurrent
    for (let i = 0; i < products.length; i += PUBLISH_CONCURRENCY) {
      const batch = products.slice(i, i + PUBLISH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (p) => {
          const res = await publishToSite(p, categoryId);
          return { product: p, res };
        })
      );
      for (const { product, res } of results) {
        if (res.ok) successes.push({ product, body: res.body });
        else        failures.push({ product, res });
      }
    }

    // Cleanup / partial cleanup
    if (failures.length === 0) {
      await pendingRef.delete().catch(() => {});
    } else if (successes.length > 0) {
      // Keep only failed products so user can retry
      await pendingRef.update({
        products:    failures.map((f) => f.product),
        processing:  false,
        processingAt: 0,
      }).catch(() => {});
    } else {
      // All failed — release lock
      await pendingRef.update({ processing: false }).catch(() => {});
    }

    // Build summary
    const lines = [];

    for (const { product, body } of successes) {
      const label  = product.name || "Product";
      const editUrl = body.edit_url || "";
      const upcWarn = body.upc_exists ? "\n   ⚠️ Another product with this UPC already exists" : "";
      const noImage = !product._sq ? "\n   📷 No image" : "";

      // Collect what was missing (optional fields only)
      const optionalMissing = [];
      if (!product.upc  || !String(product.upc).trim())   optionalMissing.push("UPC");
      if (!product.brand || !String(product.brand).trim()) optionalMissing.push("Brand");
      if (!product.asin  || !String(product.asin).trim())  optionalMissing.push("ASIN");
      const missingLine = optionalMissing.length
        ? `\n   ⚠️ Missing: ${optionalMissing.join(", ")}`
        : "";

      lines.push(
        `✅ ${label}\n` +
        `   Created as draft${editUrl ? ` → ${editUrl}` : ""}` +
        missingLine +
        upcWarn +
        noImage
      );
    }

    for (const { product, res } of failures) {
      const label  = product.name || "Product";
      const reason = formatPublishError(res);
      lines.push(`❌ ${label}\n   ${reason}`);
    }

    await sendMessage(chatId, lines.join("\n\n"));

    // Retry button if some failed
    if (failures.length > 0 && successes.length > 0) {
      await sendMessage(
        chatId,
        `${failures.length} product(s) failed. Tap to retry:`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔄 Retry failed", callback_data: "site_retry" }]],
          },
        }
      );
    }

    return successes.length > 0;
  } catch (err) {
    console.error("[SITE_PUBLISH] error:", err.message);
    await pendingRef.update({ processing: false }).catch(() => {});
    await sendMessage(chatId, "❌ An unexpected error occurred while publishing. Please try again.").catch(() => {});
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility: human-readable error from a failed publishToSite result
// ---------------------------------------------------------------------------
function formatPublishError({ status, body }) {
  if (status === 401)  return "Website API key is wrong (401).";
  if (status === 422) {
    const errs = body.errors || {};
    const parts = Object.values(errs).flat().slice(0, 3).join("; ");
    return `Validation error: ${parts || body.message || "invalid data"}`;
  }
  if (status === 0)    return "Website not reachable (timeout or network error).";
  return `Unexpected error (HTTP ${status}): ${body.message || "unknown"}`;
}

// ---------------------------------------------------------------------------
// handleCategoryCallback — called from callbacks.js for site_cat / site_back /
// site_page / site_change / site_cancel / site_confirm / site_retry
// ---------------------------------------------------------------------------
async function handleSiteCallback(chatId, msgId, data) {
  // ── site_cancel ──
  if (data === "site_cancel") {
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    await db.collection("sitePending").doc(String(chatId)).delete().catch(() => {});
    await sendMessage(chatId, "❌ Website publishing cancelled.");
    return;
  }

  // ── site_same_for_all: acknowledgement button — no state change needed ──
  // The category picker already applies one chosen category to all products.
  // This button just confirms the intent to the user.
  if (data === "site_same_for_all") {
    const snap = await db.collection("sitePending").doc(String(chatId)).get();
    const count = snap.exists ? (snap.data().products || []).length : 0;
    await sendMessage(
      chatId,
      `✅ Got it — the category you select below will be applied to all ${count} product(s).`
    ).catch(() => {});
    return;
  }

  // ── site_confirm_blocked (required fields missing) ──
  if (data === "site_confirm_blocked") {
    await sendMessage(chatId, "❌ Cannot publish: one or more required fields (name, price, units) are missing. Reply with the value to fill them in.");
    return;
  }

  // Load pending data (needed for all remaining handlers)
  const pendingRef = db.collection("sitePending").doc(String(chatId));
  const snap = await pendingRef.get();
  if (!snap.exists) {
    await sendMessage(chatId, "⏳ Session expired, please send the links again.");
    return;
  }
  const pending = snap.data();

  // Check session age
  if (Date.now() - (pending.createdAt || 0) > SESSION_TTL_MS) {
    await sendMessage(chatId, "⏳ Session expired, please send the links again.");
    await pendingRef.delete().catch(() => {});
    return;
  }

  const categories = pending.categories || [];

  // ── site_change: go back to category picker ──
  if (data === "site_change") {
    await pendingRef.update({ categoryId: null }).catch(() => {});
    const count = (pending.products || []).length;
    const keyboard = buildCategoryKeyboard(categories, null, 0, count);
    await editMessageText(
      chatId, msgId,
      `📂 Select a category for ${count} product(s):`,
      { reply_markup: keyboard }
    );
    return;
  }

  // ── site_page:N:parentId ──
  if (data.startsWith("site_page:")) {
    const parts    = data.split(":");
    const page     = parseInt(parts[1], 10) || 0;
    const parentId = parseInt(parts[2], 10) || null;
    const normParent = parentId === 0 ? null : parentId;
    const productCount = (pending.products || []).length;

    const keyboard = buildCategoryKeyboard(categories, normParent, page, productCount);
    await editMessageReplyMarkup(chatId, msgId, keyboard).catch(() => {});
    return;
  }

  // ── site_back:parentId ──
  if (data.startsWith("site_back:")) {
    const raw      = parseInt(data.split(":")[1], 10);
    const parentId = raw === 0 ? null : raw;
    const productCount = (pending.products || []).length;

    const keyboard = buildCategoryKeyboard(categories, parentId, 0, productCount);
    await editMessageReplyMarkup(chatId, msgId, keyboard).catch(() => {});
    return;
  }

  // ── site_cat:catId ── (tap a category)
  if (data.startsWith("site_cat:")) {
    const catId  = parseInt(data.split(":")[1], 10);
    const cat    = categories.find((c) => c.id === catId);
    const hasChildren = categories.some((c) => c.parent_id === catId);

    // If it has children, drill down
    if (hasChildren) {
      const keyboard = buildCategoryKeyboard(categories, catId, 0);
      await editMessageReplyMarkup(chatId, msgId, keyboard).catch(() => {});
      return;
    }

    // It's a leaf — confirm selection
    await pendingRef.update({ categoryId: catId }).catch(() => {});

    const products = pending.products || [];
    const allGood  = products.every((p) => missingRequired(p).length === 0);
    const catName  = cat ? cat.name : `Category ${catId}`;

    // Build a summary of what will be posted
    const productLines = products
      .map((p, i) => {
        const missing = missingRequired(p);
        const warn = missing.length ? ` ⚠️ missing: ${missing.join(", ")}` : "";
        return `  ${i + 1}. ${p.name || "(untitled)"}${warn}`;
      })
      .join("\n");

    const summaryText =
      `📂 Category: *${catName}*\n\n` +
      `📦 ${products.length} product(s):\n${productLines}\n\n` +
      (allGood ? "Ready to post to the website." : "⚠️ Some required fields are missing (see above).");

    await editMessageText(
      chatId, msgId,
      summaryText,
      {
        parse_mode:   "Markdown",
        reply_markup: buildConfirmKeyboard(allGood),
      }
    );
    return;
  }

  // ── site_confirm ──
  if (data === "site_confirm") {
    // Remove buttons immediately; publish runs in background
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    await publishSiteFlow(chatId);
    return;
  }

  // ── site_retry ──
  if (data === "site_retry") {
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    await publishSiteFlow(chatId);
    return;
  }
}

/**
 * websitePreviewFlow — the function registered with waitUntil in webhook.js.
 *
 * Does the full website-mode pipeline in one background task:
 *   1. Scrapes all products in parallel (just like the generic handler does)
 *   2. Prepares 500x500 images
 *   3. Sends a preview card per product (text + image)
 *   4. Delegates to sitePreviewFlow for Firestore save + category picker
 *
 * @param {string|number} chatId
 * @param {object[]}      parsedProducts  - Output of parseMultiProduct()
 * @param {string[]}      fields          - Enabled field keys for website mode
 */
async function websitePreviewFlow(chatId, parsedProducts, fields) {
  try {
    await sendMessage(chatId, `\uD83D\uDD0D Scraping ${parsedProducts.length} product(s)\u2026 please wait.`);

    // 1. Scrape all products in parallel
    const results = await Promise.all(
      parsedProducts.map(async (p) => {
        const info = await scrapeProduct(p.url);
        return { ...p, ...info, _ok: !!(info.name || info.upc) };
      })
    );

    const successful = results.filter((r) => r._ok);
    const failed     = results.filter((r) => !r._ok);

    // 2. Prepare 500x500 images in parallel
    if (new Set(fields).has("image")) {
      await Promise.all(
        successful.map(async (p) => {
          if (p.image && typeof p.image === "string" && p.image.startsWith("http")) {
            p._sq = await squareImage(p.image).catch(() => null);
          }
        })
      );
    }

    // 3. Send one preview card per product (same style as generic sendProductReply)
    const sel = new Set(fields);
    for (let i = 0; i < successful.length; i++) {
      const p = successful[i];
      const caption = formatCaption("website", p, fields);
      const hasImage = sel.has("image") && p.image && typeof p.image === "string" && p.image.startsWith("http");

      if (hasImage) {
        const photoRes = await sendSquarePhoto(chatId, p.image, caption, {}, p._sq);
        if (!photoRes.ok) await sendMessage(chatId, caption);
      } else {
        await sendMessage(chatId, caption);
      }

      if (successful.length > 5) await sleep(200);
    }

    // Report failed scrapes
    if (failed.length > 0) {
      await sendMessage(
        chatId,
        `\u26A0\uFE0F ${failed.length} product(s) could not be scraped:\n` +
        failed.map((f) => `  \u2022 ${f.url}`).join("\n")
      );
    }

    // 4. If nothing scraped, stop here
    if (successful.length === 0) {
      await sendMessage(chatId, "\u274C Could not scrape any products. No website draft created.");
      return;
    }

    // 5. Show category picker (sitePreviewFlow saves to Firestore + fetches categories)
    await sitePreviewFlow(chatId, successful);

  } catch (err) {
    console.error("[WEBSITE_PREVIEW] error:", err.message);
    await sendMessage(chatId, "\u274C Something went wrong. Please try again.").catch(() => {});
  }
}

module.exports = {
  websitePreviewFlow,
  sitePreviewFlow,
  publishSiteFlow,
  handleSiteCallback,
  siteConfigured,
  // Exposed for testing:
  parseExpDate,
  normaliseNumber,
  normaliseInt,
  PRODUCT_CONSTANTS,
};
