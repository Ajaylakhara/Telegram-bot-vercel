const { db, isFirebaseReady } = require("./firebase");
const {
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
  sendMessage,
} = require("./telegram");
const { MODE_FIELDS, FIELD_LABELS, buildFieldKeyboard } = require("./format");
const { createMailchimpDraftFlow } = require("./mailchimpFlow");
const { handleSiteCallback } = require("./website");
const { waitUntil } = require("@vercel/functions");

const MODE_SELECT_KEYBOARD = {
  inline_keyboard: [[
    { text: "📧 Mail", callback_data: "mail" },
    { text: "💼 LinkedIn", callback_data: "linkedin" },
    { text: "🌐 Website", callback_data: "website" },
  ]],
};

/**
 * Handles every callback_query from the inline keyboards: mode selection,
 * field toggles, select-all/none, change-mode, and the final "Done".
 * Returns true once handled (caller should just respond 200 OK after).
 */
async function handleCallbackQuery(body) {
  const cq = body.callback_query;
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;
  const data = cq.data; // e.g. "mail", "field:upc", "change_mode", "fields_done", "toggle_all"

  await answerCallbackQuery(cq.id);
  if (!chatId) return;

  const userRef = db.collection("userModes").doc(String(chatId));

  // ── "↩️ Change Mode" ──
  if (data === "change_mode") {
    await editMessageText(chatId, msgId, "Please select a mode:", {
      reply_markup: MODE_SELECT_KEYBOARD,
    });
    return;
  }

  // ── Mode selected (mail / linkedin / website) ──
  if (data === "mail" || data === "linkedin" || data === "website") {
    const mode = data;
    const doc = await userRef.get();
    const savedFields = doc.exists ? (doc.data().fields || {})[mode] || null : null;
    const defaultFields = savedFields || MODE_FIELDS[mode];

    await userRef.set(
      { pendingMode: mode, pendingFields: { [mode]: defaultFields } },
      { merge: true }
    );

    await editMessageText(
      chatId,
      msgId,
      `Choose which fields to include for *${mode.charAt(0).toUpperCase() + mode.slice(1)}* mode:`,
      { parse_mode: "Markdown", reply_markup: buildFieldKeyboard(mode, defaultFields) }
    );
    return;
  }

  // ── "☑️ All" / "⬜ None" ──
  if (data === "toggle_all") {
    const doc = await userRef.get();
    if (!doc.exists) return;

    const docData = doc.data();
    const pendingMode = docData.pendingMode;
    if (!pendingMode) return;

    const pendingFields = docData.pendingFields || {};
    const current = pendingFields[pendingMode] || MODE_FIELDS[pendingMode];
    const allFields = MODE_FIELDS[pendingMode] || [];

    const allSelected = allFields.every((f) => new Set(current).has(f));
    const next = allSelected ? [] : [...allFields];

    await userRef.set({ pendingFields: { ...pendingFields, [pendingMode]: next } }, { merge: true });
    await editMessageReplyMarkup(chatId, msgId, buildFieldKeyboard(pendingMode, next));
    return;
  }

  // ── Field toggle (field:<key>) ──
  if (data.startsWith("field:")) {
    const fieldKey = data.slice(6);
    const doc = await userRef.get();
    if (!doc.exists) return;

    const docData = doc.data();
    const pendingMode = docData.pendingMode;
    if (!pendingMode) return;

    const pendingFields = docData.pendingFields || {};
    let current = pendingFields[pendingMode] || MODE_FIELDS[pendingMode];

    const set = new Set(current);
    if (set.has(fieldKey)) set.delete(fieldKey);
    else set.add(fieldKey);
    current = (MODE_FIELDS[pendingMode] || []).filter((f) => set.has(f));

    await userRef.set({ pendingFields: { ...pendingFields, [pendingMode]: current } }, { merge: true });
    await editMessageReplyMarkup(chatId, msgId, buildFieldKeyboard(pendingMode, current));
    return;
  }

  // ── "✔️ Done" ──
  if (data === "fields_done") {
    const doc = await userRef.get();
    if (!doc.exists) return;

    const docData = doc.data();
    const pendingMode = docData.pendingMode;
    const pendingFields = docData.pendingFields || {};
    const confirmedFields = pendingFields[pendingMode] || MODE_FIELDS[pendingMode];

    const existingFields = docData.fields || {};
    await userRef.set(
      {
        mode: pendingMode,
        fields: { ...existingFields, [pendingMode]: confirmedFields },
        pendingMode: null,
        pendingFields: {},
      },
      { merge: true }
    );

    const modeLabel = pendingMode === "mail" ? "Mail" : pendingMode === "website" ? "Website" : "LinkedIn";
    const fieldLabels = confirmedFields.filter((f) => f !== "image").map((f) => FIELD_LABELS[f]).join(", ");
    const imageNote = confirmedFields.includes("image") ? " + Image" : "";

    await editMessageText(
      chatId,
      msgId,
      `✅ ${modeLabel} mode set — showing: ${fieldLabels}${imageNote}\n\nNow send your product data.`
    );
    return;
  }
  // ── "✅ Create Mailchimp Draft" ──
  if (data === "mc_confirm") {
    // Buttons stay on the preview until the draft is created, so a failed
    // attempt can simply be retried by pressing the button again.
    const ok = await createMailchimpDraftFlow(chatId);
    if (ok) await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    return;
  }

  // ── "❌ Cancel" (Mailchimp) ──
  if (data === "mc_cancel") {
    // Remove buttons and update preview message
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    // Delete pending data from Firestore
    await db.collection("mailPending").doc(String(chatId)).delete().catch(() => {});
    await sendMessage(chatId, "\u274C Mailchimp draft creation cancelled.");
    return;
  }

  // ── Website flow: site_cat / site_back / site_page / site_change /
  //                  site_confirm / site_confirm_blocked / site_retry /
  //                  site_cancel / site_same_for_all ──
  if (
    data === "site_cancel" ||
    data === "site_change" ||
    data === "site_confirm" ||
    data === "site_confirm_blocked" ||
    data === "site_retry" ||
    data === "site_same_for_all" ||
    data.startsWith("site_cat:") ||
    data.startsWith("site_back:") ||
    data.startsWith("site_page:")
  ) {
    // site_confirm and site_retry can take up to 25 s per product;
    // use waitUntil so Vercel keeps the function alive after the 200 is sent.
    waitUntil(handleSiteCallback(chatId, msgId, data).catch((e) =>
      console.error("[site_callback] error:", e.message)
    ));
    return;
  }
}

module.exports = { handleCallbackQuery, MODE_SELECT_KEYBOARD };