const { db } = require("../routing/lib/firebase");
const { sendMessage, sendPhoto } = require("../routing/lib/telegram");
const { parseMultiProduct } = require("../routing/lib/parser");
const { scrapeProduct, sleep } = require("../routing/lib/scraper");
const { MODE_FIELDS, formatCaption } = require("../routing/lib/format");
const { isInventoryMessage, handleInventoryMessage } = require("../routing/lib/inventory");
const { handleCallbackQuery, MODE_SELECT_KEYBOARD } = require("../routing/lib/callbacks");
const { waitUntil } = require("@vercel/functions");
const { getMasterTemplateHtml, createMailchimpTemplate, getMailchimpDc } = require("../routing/lib/mailchimp");
const { generateMailchimpHTML, getTemplateName } = require("../routing/lib/mailchimpTemplate");

/**
 * Sends one formatted reply for a scraped product, respecting the user's
 * selected fields for the active mode (text-only, image-only, or both).
 */
async function sendProductReply(chatId, mode, product, fields) {
  const fieldSet = new Set(fields);
  const wantImage = fieldSet.has("image");
  const hasImage = wantImage && product.image && typeof product.image === "string" && product.image.startsWith("http");
  const textFields = fields.filter((f) => f !== "image");
  const onlyImage = wantImage && textFields.length === 0;
  const caption = onlyImage ? "" : formatCaption(mode, product, fields);

  // Only "Image" selected
  if (onlyImage) {
    if (hasImage) {
      const pj = await sendPhoto(chatId, product.image);
      if (pj.ok) return;
      console.log(`[send] sendPhoto (image-only) failed: ${pj.description}`);
    }
    return; // nothing to send if image wanted but unavailable, and no text fields
  }

  // Image not selected at all — always plain text
  if (!wantImage) {
    await sendMessage(chatId, caption);
    return;
  }

  // Image selected + text fields present — try photo+caption, fall back to text
  let sent = false;
  if (hasImage) {
    const photoJson = await sendPhoto(chatId, product.image, caption);
    if (photoJson.ok) sent = true;
    else console.log(`[send] sendPhoto failed: ${photoJson.description}`);
  }
  if (!sent) await sendMessage(chatId, caption);
}

// ---------------------------------------------------------------------------
// Mailchimp flow (runs inside waitUntil after res.status(200) is sent)
// ---------------------------------------------------------------------------

/** Maps error codes to clean Telegram-safe messages (no internal details exposed). */
function mailchimpErrorMessage(code) {
  const map = {
    config_missing:    "\u274C Mailchimp is not configured. Contact the administrator.",
    master_id_missing: "\u274C Master template ID is not configured.",
    master_not_found:  "\u274C Could not load the master Mailchimp template.\nCheck MAILCHIMP_MASTER_TEMPLATE_ID.",
    master_html_empty: "\u274C Master template HTML is empty.\nEnsure it is a Classic/custom-coded template, not New Builder.",
    marker_missing:    "\u274C Master template is missing product block markers.\nAdd <!-- PRODUCT_BLOCK_START/END --> to the master template first.",
    all_scraped_failed:"\u274C Could not scrape any products. No Mailchimp template was created.",
    auth_failed:       "\u274C Mailchimp authentication failed. Check the API key.",
    rate_limited:      "\u274C Mailchimp rate limit reached. Please try again in a moment.",
    server_error:      "\u274C Mailchimp server error. Please try again.",
    network_error:     "\u274C Could not connect to Mailchimp. Please try again.",
    bad_request:       "\u274C Could not create Mailchimp template. Please try again.",
  };
  return map[code] || "\u274C An unexpected error occurred. Please try again.";
}

/**
 * Full Mailchimp template creation flow.
 * Called inside waitUntil() -- runs after HTTP 200 has been sent to Telegram.
 *
 * @param {string|number} chatId
 * @param {object[]}      parsedProducts  - Output of parseMultiProduct()
 * @param {string[]}      fields          - Enabled field keys from Firestore
 */
async function mailchimpFlow(chatId, parsedProducts, fields) {
  try {
    await sendMessage(
      chatId,
      `\uD83D\uDD0D Creating Mailchimp template for ${parsedProducts.length} product(s)\u2026 please wait.`
    );

    // Step 1: Fetch master template HTML (Option A -- GET /default-content)
    const masterHtml = await getMasterTemplateHtml();

    // Step 2: Scrape all products in parallel.
    // scrapeProduct NEVER throws -- always returns { name, brand, ... }.
    // Failure is detected by name === "" (empty string).
    const results = await Promise.all(
      parsedProducts.map(async (p) => {
        const info = await scrapeProduct(p.url);
        return { ...p, ...info, _ok: !!info.name };
      })
    );

    const successful = results.filter((r) => r._ok);
    const failed    = results.filter((r) => !r._ok);

    // Step 3: Abort if all scrapes failed
    if (successful.length === 0) {
      await sendMessage(chatId, mailchimpErrorMessage("all_scraped_failed"));
      return;
    }

    // Step 4: Generate the final template HTML
    const templateName = getTemplateName(successful);
    const finalHtml    = generateMailchimpHTML(masterHtml, successful, fields);

    // Step 5: Create the new Mailchimp template
    const { templateId, templateName: createdName } = await createMailchimpTemplate(templateName, finalHtml);

    // Step 6: Build and send the confirmation message
    let dc = "us1";
    try { dc = getMailchimpDc(); } catch (_) { /* non-critical */ }

    const skippedNote = failed.length > 0
      ? `\n\u26A0\uFE0F ${failed.length} product(s) skipped (scrape returned no data):\n` +
        failed.map((f) => `   \u2022 ${f.url}`).join("\n")
      : "";

    const masterId = (process.env.MAILCHIMP_MASTER_TEMPLATE_ID || "N/A").trim();

    await sendMessage(
      chatId,
      `\u2705 Mailchimp Template Created\n\n` +
      `\uD83D\uDCE7 Template: ${createdName}\n` +
      `\uD83D\uDCE6 Products: ${successful.length}${failed.length > 0 ? ` of ${results.length} created` : ""}` +
      skippedNote +
      `\n\uD83C\uDD94 Template ID: ${templateId}` +
      `\n\uD83C\uDFA8 Master ID: ${masterId} (unchanged)` +
      `\n\n\u26A0\uFE0F Email NOT sent. Template created only.` +
      `\n\u26A0\uFE0F Master template was NOT modified.` +
      `\n\uD83D\uDD17 https://${dc}.admin.mailchimp.com/templates/`
    );

  } catch (err) {
    console.error("[MAILCHIMP] Flow error:", err.message, "| code:", err.code);
    const msg = mailchimpErrorMessage(err.code);
    await sendMessage(chatId, msg).catch(() => {});
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");
  const body = req.body;
  if (!body) return res.status(200).send("OK");

  // ----- Deduplication (Telegram retries webhooks that don't respond in ~5s) -----
  const updateId = body.update_id;
  if (updateId) {
    const updateRef = db.collection("processedUpdates").doc(String(updateId));
    const existing = await updateRef.get();
    if (existing.exists) {
      console.log(`[handler] Duplicate update_id ${updateId}, ignoring.`);
      return res.status(200).send("OK");
    }
    await updateRef.set({ ts: Date.now() });
  }

  try {
    // ----- Button click (mode selection / field toggling) -----
    if (body.callback_query) {
      await handleCallbackQuery(body);
      return res.status(200).send("OK");
    }

    const message = body.message?.text;
    const chatId = body.message?.chat?.id;
    if (!message || !chatId) return res.status(200).send("OK");

    // ----- /start -----
    const trimmedLower = message.trim().toLowerCase();
    if (trimmedLower === "/start" || trimmedLower === "start" || trimmedLower.startsWith("/start@")) {
      await sendMessage(chatId, "Please select a mode:", { reply_markup: MODE_SELECT_KEYBOARD });
      return res.status(200).send("OK");
    }

    // ----- Load saved mode + fields -----
    const modeDoc = await db.collection("userModes").doc(String(chatId)).get();
    const mode = modeDoc.exists ? modeDoc.data().mode : null;
    const savedFields = modeDoc.exists ? (modeDoc.data().fields || {})[mode] || MODE_FIELDS[mode] : null;

    if (!mode) {
      await sendMessage(chatId, "Please use /start to select a mode first.");
      return res.status(200).send("OK");
    }

    // ----- Inventory / wholesale fast-path (auto-detected) -----
    if (isInventoryMessage(message)) {
      res.status(200).send("OK"); // ack immediately; function keeps running after this on Vercel
      await handleInventoryMessage(chatId, message);
      return;
    }

    // ----- Standard multi-product scrape flow -----
    const products = parseMultiProduct(message);

    // Zero-products guard -- applies to ALL modes
    if (products.length === 0) {
      await sendMessage(chatId, "No product URLs found in your message. Please include at least one Amazon or Walmart link.");
      return res.status(200).send("OK");
    }

    // ----- Mail mode: hand off to Mailchimp flow -----
    if (mode === "mail") {
      const fields = savedFields || MODE_FIELDS[mode];
      // Register background work BEFORE sending the HTTP response (required by Vercel)
      waitUntil(mailchimpFlow(chatId, products, fields));
      return res.status(200).send("OK");
    }

    console.log(`[handler] Scraping ${products.length} products in parallel...`);
    const scrapedResults = await Promise.all(
      products.map((p) => scrapeProduct(p.url).then((info) => ({ ...p, ...info })))
    );

    const fields = savedFields || MODE_FIELDS[mode];
    for (const product of scrapedResults) {
      await sendProductReply(chatId, mode, product, fields);
      if (scrapedResults.length > 5) await sleep(200); // gentle throttle for large batches
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[handler] Unhandled error:", err);
  }

  return res.status(200).send("OK");
};