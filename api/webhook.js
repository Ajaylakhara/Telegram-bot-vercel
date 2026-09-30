const { db } = require("../routing/lib/firebase");
const { sendMessage, sendPhoto } = require("../routing/lib/telegram");
const { parseMultiProduct } = require("../routing/lib/parser");
const { scrapeProduct, sleep } = require("../routing/lib/scraper");
const { MODE_FIELDS, formatCaption } = require("../routing/lib/format");
const { isInventoryMessage, handleInventoryMessage } = require("../routing/lib/inventory");
const { handleCallbackQuery, MODE_SELECT_KEYBOARD } = require("../routing/lib/callbacks");

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
    if (products.length === 0) return res.status(200).send("OK");

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