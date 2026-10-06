require("./env");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Send a plain text message. `extra` can include reply_markup, parse_mode, etc. */
async function sendMessage(chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    return await res.json();
  } catch (e) {
    console.error("sendMessage error:", e);
    return { ok: false };
  }
}

/** Send a photo. Pass no `caption` to send the photo with no caption at all. `extra` can include parse_mode, etc. */
async function sendPhoto(chatId, photo, caption, extra = {}) {
  const payload = { chat_id: chatId, photo, ...extra };
  if (caption !== undefined) payload.caption = caption;
  try {
    const res = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.log(`[send] sendPhoto error: ${e.message}`);
    return { ok: false };
  }
}

/**
 * Send a photo from raw bytes (multipart upload). Used for the processed
 * 500x500 white-background product images. `extra` can include parse_mode, etc.
 */
async function sendPhotoBuffer(chatId, buffer, caption, extra = {}) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", buffer, { filename: "product.jpg", contentType: "image/jpeg" });
  if (caption !== undefined && caption !== "") form.append("caption", caption);
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  try {
    const res = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    return await res.json();
  } catch (e) {
    console.log(`[send] sendPhotoBuffer error: ${e.message}`);
    return { ok: false };
  }
}

/** Send a file (e.g. the inventory .xlsx) as a Telegram document. */
async function sendDocument(chatId, buffer, filename, contentType) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", buffer, { filename, contentType });
  try {
    const res = await fetch(`${TG_API}/sendDocument`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    return await res.json();
  } catch (e) {
    console.error("[telegram] sendDocument error:", e);
    return { ok: false };
  }
}

async function answerCallbackQuery(callbackQueryId) {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (e) {
    console.error("answerCallbackQuery error:", e);
  }
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    await fetch(`${TG_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
    });
  } catch (e) {
    console.error("editMessageText error:", e);
  }
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    await fetch(`${TG_API}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    });
  } catch (e) {
    console.error("editMessageReplyMarkup error:", e);
  }
}

module.exports = {
  TG_API,
  sendMessage,
  sendPhoto,
  sendPhotoBuffer,
  sendDocument,
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
};
