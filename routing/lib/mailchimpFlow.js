/**
 * STEP 2 of the mail flow (the "Create Mailchimp Draft" button):
 * loads the scraped products saved by the preview step, fills the master email
 * (routing/templates/master.html), creates a DRAFT campaign in Mailchimp and
 * sends a test email. It never sends to the audience.
 */

"use strict";

const { db } = require("./firebase");
const { sendMessage } = require("./telegram");
const { createCampaignDraft, getMailchimpDc } = require("./mailchimp");
const {
  generateMailchimpHTML,
  getTemplateName,
  buildSubject,
  loadMasterHtml,
} = require("./mailchimpTemplate");

/** Maps error codes to Telegram-safe messages (no internal details exposed). */
function mailchimpErrorMessage(code) {
  const map = {
    config_missing:
      "❌ Mailchimp is not configured. Check MAILCHIMP_API_KEY and MAILCHIMP_MASTER_CAMPAIGN_ID.",
    master_campaign_not_found:
      "❌ Master campaign not found in Mailchimp.\nCheck MAILCHIMP_MASTER_CAMPAIGN_ID.",
    master_file_missing: "❌ Master email file (routing/templates/master.html) could not be read.",
    marker_missing:
      "❌ Master email is missing the product block markers.\nCheck routing/templates/master.html.",
    all_scraped_failed: "❌ Could not scrape any products. No Mailchimp draft was created.",
    auth_failed: "❌ Mailchimp authentication failed. Check the API key.",
    rate_limited: "❌ Mailchimp rate limit reached. Please try again in a moment.",
    server_error: "❌ Mailchimp server error. Please try again.",
    network_error: "❌ Could not connect to Mailchimp. Please try again.",
    bad_request: "❌ Mailchimp rejected the draft. Please try again.",
    not_found: "❌ Mailchimp could not find the item. Please try again.",
  };
  return map[code] || "❌ An unexpected error occurred. Please try again.";
}

/**
 * @param {string|number} chatId
 * @returns {Promise<boolean>} true when a draft was created
 */
async function createMailchimpDraftFlow(chatId) {
  const pendingRef = db.collection("mailPending").doc(String(chatId));

  // Claim the pending data atomically so a double-click can't create two drafts.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (!snap.exists) return { state: "missing" };
    const d = snap.data();
    if (d.processing && Date.now() - (d.processingAt || 0) < 120000) return { state: "busy" };
    tx.update(pendingRef, { processing: true, processingAt: Date.now() });
    return { state: "ok", data: d };
  });

  if (claim.state === "missing") {
    await sendMessage(chatId, "❌ No pending product data found. Please send the product link(s) again.");
    return false;
  }
  if (claim.state === "busy") {
    await sendMessage(chatId, "⏳ A draft is already being created. Please wait a moment.");
    return false;
  }

  const { products, fields } = claim.data;

  try {
    await sendMessage(
      chatId,
      `📧 Creating ${products.length} separate Mailchimp draft(s) — one per product… please wait.`
    );

    const masterHtml = loadMasterHtml();

    let dc = "us1";
    try { dc = getMailchimpDc(); } catch (_) { /* non-critical */ }

    const successes = [];
    const failures  = [];

    // Create ONE draft per product
    for (let i = 0; i < products.length; i++) {
      const singleProduct = [products[i]];
      try {
        const html    = generateMailchimpHTML(masterHtml, singleProduct, fields);
        const subject = buildSubject(singleProduct);
        const title   = getTemplateName(singleProduct);

        const result = await createCampaignDraft({ subject, title, html });
        successes.push({ result, product: products[i] });
      } catch (err) {
        console.error(`[MAILCHIMP_DRAFT] product ${i + 1} failed:`, err.message, "| code:", err.code);
        failures.push({ product: products[i], code: err.code });
      }
    }

    // Success: only now is the pending data removed (at least 1 succeeded).
    if (successes.length > 0) {
      await pendingRef.delete().catch(() => {});
    } else {
      // All failed — release lock so user can retry
      await pendingRef.update({ processing: false }).catch(() => {});
    }

    // Build summary message
    const lines = [];

    if (successes.length > 0) {
      lines.push(`✅ ${successes.length} Mailchimp draft(s) created!\n`);
      for (let i = 0; i < successes.length; i++) {
        const { result, product } = successes[i];
        const label = product.brand || product.name || `Product ${i + 1}`;
        const link  = result.webId
          ? `https://${dc}.admin.mailchimp.com/campaigns/edit?id=${result.webId}`
          : `https://${dc}.admin.mailchimp.com/campaigns/`;
        const testLine = result.testSent
          ? `🧪 Test sent to: ${result.testEmails.join(", ")}`
          : result.testEmails?.length > 0
            ? "⚠️ Test email could not be sent."
            : "";
        lines.push(
          `📧 Draft ${i + 1}: ${label}\n` +
          `   Subject: ${result.subject}\n` +
          (testLine ? `   ${testLine}\n` : "") +
          `   🔗 ${link}`
        );
      }
      lines.push(`\n⚠️ NOT sent to your list. Review each draft in Mailchimp and press Send yourself.`);
    }

    if (failures.length > 0) {
      lines.push(`\n❌ ${failures.length} draft(s) failed:`);
      failures.forEach((f, i) => {
        const label = f.product.brand || f.product.name || `Product ${successes.length + i + 1}`;
        lines.push(`  • ${label} — ${mailchimpErrorMessage(f.code)}`);
      });
    }

    await sendMessage(chatId, lines.join("\n"));
    return successes.length > 0;
  } catch (err) {
    console.error("[MAILCHIMP_DRAFT] error:", err.message, "| code:", err.code);
    // Keep the pending data so the user can press the button again.
    await pendingRef.update({ processing: false }).catch(() => {});
    await sendMessage(chatId, mailchimpErrorMessage(err.code)).catch(() => {});
    return false;
  }
}

module.exports = { createMailchimpDraftFlow, mailchimpErrorMessage };
