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
// Mailchimp helpers
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
 * STEP 1 of the new mail flow:
 * Scrape products, show a preview to the user, then show a
 * \u201cCreate Mailchimp Template\u201d button. Scraped data is stored in Firestore
 * so the button handler can retrieve it without re-scraping.
 *
 * @param {string|number} chatId
 * @param {object[]}      parsedProducts  - Output of parseMultiProduct()
 * @param {string[]}      fields          - Enabled field keys from Firestore
 */
async function mailPreviewFlow(chatId, parsedProducts, fields) {
  try {
    await sendMessage(chatId, `\uD83D\uDD0D Scraping ${parsedProducts.length} product(s)\u2026 please wait.`);

    // Scrape all products in parallel
    const results = await Promise.all(
      parsedProducts.map(async (p) => {
        const info = await scrapeProduct(p.url);
        return { ...p, ...info, _ok: !!info.name };
      })
    );

    const successful = results.filter((r) => r._ok);
    const failed     = results.filter((r) => !r._ok);

    if (successful.length === 0) {
      await sendMessage(chatId, mailchimpErrorMessage("all_scraped_failed"));
      return;
    }

    // Save scraped data to Firestore so the button handler can use it
    const pendingRef = db.collection("mailPending").doc(String(chatId));
    await pendingRef.set({
      products: successful,
      fields,
      createdAt: Date.now(),
    });

    const sel = new Set(fields);

    // Send each product as a SEPARATE message (with photo if image selected)
    for (let i = 0; i < successful.length; i++) {
      const p = successful[i];
      const fmtUnits = p.units ? Number(p.units).toLocaleString("en-US") : null;
      const lines = [];
      lines.push(`\uD83D\uDCE6 *Product ${i + 1} of ${successful.length}*`);
      // Subject line (mail mode)
      if (sel.has("subject")) {
        const subjectName = p.brand || p.name || "Product";
        lines.push(`\uD83D\uDCE7 *Subject:* ${subjectName} @ ${p.price || "N/A"}/unit | ${fmtUnits || "N/A"} Units`);
      }
      if (sel.has("name")  && p.name)    lines.push(`*Name:* ${p.name}`);
      if (sel.has("price") && p.price)   lines.push(`*Price:* ${p.price}`);
      if (sel.has("units") && fmtUnits)  lines.push(`*Units:* ${fmtUnits}`);
      if (p.exp)                          lines.push(`*Exp:* ${p.exp}`);
      if (sel.has("upc")   && p.upc)    lines.push(`*UPC:* ${p.upc}`);
      if (sel.has("link")  && p.url)    lines.push(`*Link:* ${p.url}`);
      if (sel.has("image") && p.image)  lines.push(`\uD83D\uDDBC\uFE0F Image: included`);

      const caption = lines.join("\n");

      // Send as photo+caption if image selected and available
      const hasValidImage = sel.has("image") && p.image && typeof p.image === "string" && p.image.startsWith("https");
      if (hasValidImage) {
        const photoRes = await sendPhoto(chatId, p.image, caption, { parse_mode: "Markdown" });
        if (!photoRes.ok) {
          // fallback to text if photo fails
          await sendMessage(chatId, caption, { parse_mode: "Markdown" });
        }
      } else {
        await sendMessage(chatId, caption, { parse_mode: "Markdown" });
      }
    }

    // Failed products note
    if (failed.length > 0) {
      await sendMessage(chatId,
        `\u26A0\uFE0F ${failed.length} product(s) could not be scraped:\n` +
        failed.map((f) => `  \u2022 ${f.url}`).join("\n")
      );
    }

    // Final confirm message with buttons
    const confirmKeyboard = {
      inline_keyboard: [[
        { text: "\u2705 Create Mailchimp Template", callback_data: "mc_confirm" },
        { text: "\u274C Cancel",                   callback_data: "mc_cancel"  },
      ]],
    };

    await sendMessage(
      chatId,
      `\u2705 All ${successful.length} product${successful.length > 1 ? "s" : ""} scraped above.\nReady to create the Mailchimp template?`,
      { reply_markup: confirmKeyboard }
    );

  } catch (err) {
    console.error("[MAIL_PREVIEW] error:", err.message);
    await sendMessage(chatId, "\u274C Something went wrong while scraping. Please try again.").catch(() => {});
  }
}

/**
 * STEP 2 of the new mail flow (triggered by the \u201cCreate Mailchimp Template\u201d button):
 * Loads saved scraped data from Firestore and creates the Mailchimp template.
 *
 * @param {string|number} chatId
 * @param {number}        msgId   - The message ID of the preview message (to edit its keyboard)
 */
async function mailchimpCreateFlow(chatId, msgId) {
  try {
    // Load pending data from Firestore
    const pendingRef = db.collection("mailPending").doc(String(chatId));
    const pendingDoc = await pendingRef.get();

    if (!pendingDoc.exists) {
      await sendMessage(chatId, "\u274C No pending product data found. Please send the product link(s) again.");
      return;
    }

    const { products: successful, fields } = pendingDoc.data();

    // Clear the pending data
    await pendingRef.delete();

    await sendMessage(chatId, `\uD83D\uDCE7 Creating Mailchimp template for ${successful.length} product(s)\u2026 please wait.`);

    // Fetch master template HTML
    const masterHtml = await getMasterTemplateHtml();

    // Generate final HTML and create the template
    const templateName = getTemplateName(successful);
    const finalHtml    = generateMailchimpHTML(masterHtml, successful, fields);
    const { templateId, templateName: createdName } = await createMailchimpTemplate(templateName, finalHtml);

    let dc = "us1";
    try { dc = getMailchimpDc(); } catch (_) { /* non-critical */ }

    await sendMessage(
      chatId,
      `\u2705 *Mailchimp Template Created!*\n\n` +
      `\uD83D\uDCE7 Template: ${createdName}\n` +
      `\uD83D\uDCE6 Products: ${successful.length}\n` +
      `\uD83C\uDD94 Template ID: ${templateId}\n\n` +
      `\u26A0\uFE0F Email NOT sent. Template created only.\n` +
      `\uD83D\uDD17 https://${dc}.admin.mailchimp.com/templates/`,
      { parse_mode: "Markdown" }
    );

  } catch (err) {
    console.error("[MAILCHIMP_CREATE] error:", err.message, "| code:", err.code);
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

    // ----- Mail mode: scrape → preview → button -----
    if (mode === "mail") {
      const fields = savedFields || MODE_FIELDS[mode];
      // Register background work BEFORE sending the HTTP response (required by Vercel)
      waitUntil(mailPreviewFlow(chatId, products, fields));
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