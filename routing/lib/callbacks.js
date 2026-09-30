const { db } = require("./firebase");
const {
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
} = require("./telegram");
const { MODE_FIELDS, FIELD_LABELS, buildFieldKeyboard } = require("./format");

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
}

module.exports = { handleCallbackQuery, MODE_SELECT_KEYBOARD };