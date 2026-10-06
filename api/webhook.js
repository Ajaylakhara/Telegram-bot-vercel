const { db } = require("../routing/lib/firebase");
const { sendMessage } = require("../routing/lib/telegram");
const { squareImage, sendSquarePhoto } = require("../routing/lib/image");
const { parseMultiProduct } = require("../routing/lib/parser");
const { scrapeProduct, sleep } = require("../routing/lib/scraper");
const { MODE_FIELDS, formatCaption } = require("../routing/lib/format");
const { isInventoryMessage, handleInventoryMessage } = require("../routing/lib/inventory");
const { handleCallbackQuery, MODE_SELECT_KEYBOARD } = require("../routing/lib/callbacks");
const { waitUntil } = require("@vercel/functions");
const { mailchimpErrorMessage } = require("../routing/lib/mailchimpFlow");

/**
 * Prepares the 500x500 white-background version of every product image in
 * parallel (before replies are sent), so many products don't add up in time.
 * Stores the Buffer on product._sq (never saved to Firestore).
 */
async function prepareSquareImages(products, fields) {
  if (!new Set(fields).has("image")) return;
  await Promise.all(
    products.map(async (p) => {
      if (p.image && typeof p.image === "string" && p.image.startsWith("http")) {
        p._sq = await squareImage(p.image);
      }
    })
  );
}

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
      const pj = await sendSquarePhoto(chatId, product.image, undefined, {}, product._sq);
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
    const photoJson = await sendSquarePhoto(chatId, product.image, caption, {}, product._sq);
    if (photoJson.ok) sent = true;
    else console.log(`[send] sendPhoto failed: ${photoJson.description}`);
  }
  if (!sent) await sendMessage(chatId, caption);
}

// ---------------------------------------------------------------------------
// Mailchimp helpers
// ---------------------------------------------------------------------------

/**
 * STEP 1 of the new mail flow:
 * Scrape products, show a preview to the user, then show a
 * \u201cCreate Mailchimp Draft\u201d button. Scraped data is stored in Firestore
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
    await prepareSquareImages(successful, fields);

    // Send each product as a SEPARATE message (with photo if image selected).
    // Plain text on purpose: product names/URLs often contain _ or * which
    // break Telegram's Markdown parser and made messages disappear.
    for (let i = 0; i < successful.length; i++) {
      const p = successful[i];
      const fmtUnits = p.units ? Number(p.units).toLocaleString("en-US") : null;
      const lines = [];
      lines.push(`\uD83D\uDCE6 Product ${i + 1} of ${successful.length}`);
      if (sel.has("subject")) {
        const subjectName = p.brand || p.name || "Product";
        lines.push(`\uD83D\uDCE7 Subject: ${subjectName} @ ${p.price || "N/A"}/unit | ${fmtUnits || "N/A"} Units`);
      }
      if (sel.has("name")  && p.name)    lines.push(`Name: ${p.name}`);
      if (sel.has("price") && p.price)   lines.push(`Price: ${p.price}`);
      if (sel.has("units") && fmtUnits)  lines.push(`Units: ${fmtUnits}`);
      if (p.exp)                          lines.push(`Exp: ${p.exp}`);
      if (sel.has("upc")   && p.upc)    lines.push(`UPC: ${p.upc}`);
      if (sel.has("link")  && p.url)    lines.push(`Link: ${p.url}`);
      if (sel.has("image") && p.image)  lines.push(`\uD83D\uDDBC\uFE0F Image: included`);

      const caption = lines.join("\n");

      const hasValidImage = sel.has("image") && p.image && typeof p.image === "string" && p.image.startsWith("https");
      if (hasValidImage) {
        const photoRes = await sendSquarePhoto(chatId, p.image, caption, {}, p._sq);
        if (!photoRes.ok) await sendMessage(chatId, caption);
      } else {
        await sendMessage(chatId, caption);
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
        { text: "\u2705 Create Mailchimp Draft", callback_data: "mc_confirm" },
        { text: "\u274C Cancel",                   callback_data: "mc_cancel"  },
      ]],
    };

    await sendMessage(
      chatId,
      `\u2705 All ${successful.length} product${successful.length > 1 ? "s" : ""} scraped above.\nReady to create the Mailchimp draft campaign?`,
      { reply_markup: confirmKeyboard }
    );

  } catch (err) {
    console.error("[MAIL_PREVIEW] error:", err.message);
    await sendMessage(chatId, "\u274C Something went wrong while scraping. Please try again.").catch(() => {});
  }
}

/** Optional allowlist: ALLOWED_CHAT_IDS="123,456". Empty/unset = everyone (old behaviour). */
function isAllowedChat(chatId) {
  const raw = (process.env.ALLOWED_CHAT_IDS || "").trim();
  if (!raw) return true;
  return raw.split(",").map((x) => x.trim()).includes(String(chatId));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  // Optional: Telegram sends this header when setWebhook was called with secret_token.
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).send("Unauthorized");
  }

  const body = req.body;
  if (!body) return res.status(200).send("OK");

  const incomingChatId = body.callback_query?.message?.chat?.id ?? body.message?.chat?.id;
  if (incomingChatId && !isAllowedChat(incomingChatId)) {
    console.log(`[handler] Ignoring update from non-allowed chat ${incomingChatId}`);
    return res.status(200).send("OK");
  }

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
      // Register the background work BEFORE responding (required on Vercel),
      // otherwise the function can be frozen right after the response is sent.
      waitUntil(handleInventoryMessage(chatId, message).catch((e) => console.error("[inventory] error:", e)));
      return res.status(200).send("OK");
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
    await prepareSquareImages(scrapedResults, fields);
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