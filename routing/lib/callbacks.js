const { db } = require("./firebase");
const {
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
  sendMessage,
} = require("./telegram");
const { MODE_FIELDS, FIELD_LABELS, buildFieldKeyboard } = require("./format");
const { getMasterTemplateHtml, createMailchimpTemplate, getMailchimpDc } = require("./mailchimp");
const { generateMailchimpHTML, getTemplateName } = require("./mailchimpTemplate");

/** Maps error codes to Telegram-safe messages. */
function mailchimpErrorMessage(code) {
  const map = {
    config_missing:    "\u274C Mailchimp is not configured. Contact the administrator.",
    master_id_missing: "\u274C Master template ID is not configured.",
    master_not_found:  "\u274C Could not load the master Mailchimp template.\nCheck MAILCHIMP_MASTER_TEMPLATE_ID.",
    master_html_empty: "\u274C Master template HTML is empty.\nEnsure it is a Classic/custom-coded template, not New Builder.",
    all_scraped_failed:"\u274C Could not scrape any products. No Mailchimp template was created.",
    auth_failed:       "\u274C Mailchimp authentication failed. Check the API key.",
    rate_limited:      "\u274C Mailchimp rate limit reached. Please try again in a moment.",
    server_error:      "\u274C Mailchimp server error. Please try again.",
    network_error:     "\u274C Could not connect to Mailchimp. Please try again.",
    bad_request:       "\u274C Could not create Mailchimp template. Please try again.",
  };
  return map[code] || "\u274C An unexpected error occurred. Please try again.";
}

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
  // ── "✅ Create Mailchimp Template" ──
  if (data === "mc_confirm") {
    // Remove buttons from the preview message immediately
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});

    try {
      // Load pending data from Firestore
      const pendingRef = db.collection("mailPending").doc(String(chatId));
      const pendingDoc = await pendingRef.get();

      if (!pendingDoc.exists) {
        await sendMessage(chatId, "\u274C No pending product data found. Please send the product link(s) again.");
        return;
      }

      const { products: successful, fields } = pendingDoc.data();
      await pendingRef.delete();

      await sendMessage(chatId, `\uD83D\uDCE7 Creating Mailchimp template for ${successful.length} product(s)\u2026 please wait.`);

      const masterHtml = await getMasterTemplateHtml();
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
      console.error("[MC_CONFIRM] error:", err.message, "| code:", err.code);
      await sendMessage(chatId, mailchimpErrorMessage(err.code)).catch(() => {});
    }
    return;
  }

  // ── "❌ Cancel" ──
  if (data === "mc_cancel") {
    // Remove buttons and update preview message
    await editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] }).catch(() => {});
    // Delete pending data from Firestore
    await db.collection("mailPending").doc(String(chatId)).delete().catch(() => {});
    await sendMessage(chatId, "\u274C Mailchimp template creation cancelled.");
    return;
  }
}

module.exports = { handleCallbackQuery, MODE_SELECT_KEYBOARD };