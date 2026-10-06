/**
 * Mailchimp API client.
 *
 * Exports:
 *   createCampaignDraft({ subject, title, html }) -> { campaignId, webId, subject, testSent, testEmails }
 *   getMailchimpDc()                              -> "us11" (data centre from the API key)
 *   getMasterTemplateHtml()                       -> (legacy) HTML of a Mailchimp master template
 *   createMailchimpTemplate(name, html)           -> (legacy) { templateId, templateName }
 *
 * Error contract: every function throws an Error with a `.code` string.
 * Callers map err.code to a user-facing message.
 *
 * GUARANTEES:
 *   - POST /campaigns/{id}/actions/send is NEVER called. A draft is created and
 *     (optionally) a TEST email is sent. You review and press Send in Mailchimp.
 *   - The master campaign is NEVER modified (it is only replicated).
 *   - The API key is NEVER logged or returned to the user.
 *
 * Environment variables:
 *   MAILCHIMP_API_KEY              required   (format: xxxxxxxx-us11)
 *   MAILCHIMP_MASTER_CAMPAIGN_ID   recommended (e.g. 4f7bc78569). The draft is a copy of
 *                                  this campaign, so list + from name + reply-to are kept.
 *   MAILCHIMP_LIST_ID              only needed when no master campaign is set
 *   MAILCHIMP_FROM_NAME            only needed when no master campaign is set
 *   MAILCHIMP_REPLY_TO             only needed when no master campaign is set
 *   MAILCHIMP_TEST_EMAILS          optional, comma separated; test email is sent here
 */

"use strict";

const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function configError(message) {
  const err = new Error(message);
  err.code = "config_missing";
  return err;
}

function getApiKey() {
  const apiKey = (process.env.MAILCHIMP_API_KEY || "").trim();
  if (!apiKey) throw configError("MAILCHIMP_API_KEY environment variable is not set");
  return apiKey;
}

function buildHeaders() {
  const encoded = Buffer.from(`anystring:${getApiKey()}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
  };
}

function getDataCenter() {
  const apiKey = getApiKey();
  const dc = apiKey.split("-").pop();
  if (!dc || dc === apiKey) {
    throw configError("MAILCHIMP_API_KEY appears malformed -- expected format: key-dcXX");
  }
  return dc;
}

/**
 * Calls the Mailchimp API.
 * @param {string} path       e.g. "/campaigns/abc/content"
 * @param {object} [opts]     { method, body, notFoundCode }
 * @param {number} [attempt]  internal (one retry on 429)
 */
async function mc(path, opts = {}, attempt = 1) {
  const { method = "GET", body, notFoundCode = "not_found" } = opts;
  const url = `https://${getDataCenter()}.api.mailchimp.com/3.0${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: buildHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: 15000,
    });
  } catch (networkErr) {
    const err = new Error(`Network error: ${networkErr.message}`);
    err.code = "network_error";
    throw err;
  }

  if (response.status === 429 && attempt === 1) {
    console.warn("[MAILCHIMP] Rate limited (429), retrying after 1s...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return mc(path, opts, 2);
  }

  if (response.status === 401) {
    const err = new Error("Mailchimp authentication failed (401)");
    err.code = "auth_failed";
    throw err;
  }

  if (response.status === 404) {
    const err = new Error(`Mailchimp resource not found (404): ${method} ${path}`);
    err.code = notFoundCode;
    throw err;
  }

  if (response.status === 429) {
    const err = new Error("Mailchimp rate limit exceeded after retry");
    err.code = "rate_limited";
    throw err;
  }

  if (response.status === 400 || response.status === 403 || response.status === 422) {
    const text = await response.text();
    const err = new Error(`Mailchimp request rejected (${response.status}) ${method} ${path}: ${text}`);
    err.code = "bad_request";
    throw err;
  }

  if (response.status >= 500) {
    const err = new Error(`Mailchimp server error (${response.status})`);
    err.code = "server_error";
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`Unexpected Mailchimp response: ${response.status}`);
    err.code = "server_error";
    throw err;
  }

  // 204 No Content (e.g. test-email action) has no body.
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Draft campaign (main flow)
// ---------------------------------------------------------------------------

function parseTestEmails() {
  return (process.env.MAILCHIMP_TEST_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
    .slice(0, 5); // Mailchimp allows max 5 test recipients
}

/**
 * Creates a DRAFT campaign containing `html`, then sends a test email (if
 * MAILCHIMP_TEST_EMAILS is set). Never sends to the audience.
 */
async function createCampaignDraft({ subject, title, html }) {
  const masterId = (process.env.MAILCHIMP_MASTER_CAMPAIGN_ID || "").trim();

  let campaign;
  if (masterId) {
    console.log(`[MAILCHIMP] Replicating master campaign ${masterId}`);
    campaign = await mc(`/campaigns/${encodeURIComponent(masterId)}/actions/replicate`, {
      method: "POST",
      notFoundCode: "master_campaign_not_found",
    });
  } else {
    const listId = (process.env.MAILCHIMP_LIST_ID || "").trim();
    const fromName = (process.env.MAILCHIMP_FROM_NAME || "").trim();
    const replyTo = (process.env.MAILCHIMP_REPLY_TO || "").trim();
    if (!listId || !fromName || !replyTo) {
      throw configError(
        "Set MAILCHIMP_MASTER_CAMPAIGN_ID, or MAILCHIMP_LIST_ID + MAILCHIMP_FROM_NAME + MAILCHIMP_REPLY_TO"
      );
    }
    console.log("[MAILCHIMP] Creating new draft campaign");
    campaign = await mc("/campaigns", {
      method: "POST",
      body: {
        type: "regular",
        recipients: { list_id: listId },
        settings: { subject_line: subject, title, from_name: fromName, reply_to: replyTo },
      },
    });
  }

  if (!campaign || !campaign.id) {
    const err = new Error("Mailchimp campaign response is missing an id");
    err.code = "bad_request";
    throw err;
  }
  const campaignId = campaign.id;
  const webId = campaign.web_id;

  // 1) Put the generated HTML into the draft.
  await mc(`/campaigns/${campaignId}/content`, { method: "PUT", body: { html } });

  // 2) Set subject + title. Keep the replica's sender settings unchanged.
  const prev = campaign.settings || {};
  const settings = { subject_line: subject, title };
  if (prev.from_name) settings.from_name = prev.from_name;
  if (prev.reply_to) settings.reply_to = prev.reply_to;
  await mc(`/campaigns/${campaignId}`, { method: "PATCH", body: { settings } });

  // 3) Optional test email (failure here must not lose the draft).
  const testEmails = parseTestEmails();
  let testSent = false;
  if (testEmails.length > 0) {
    try {
      await mc(`/campaigns/${campaignId}/actions/test`, {
        method: "POST",
        body: { test_emails: testEmails, send_type: "html" },
      });
      testSent = true;
    } catch (e) {
      console.error("[MAILCHIMP] Test email failed:", e.message, "| code:", e.code);
    }
  }

  console.log(`[MAILCHIMP] Draft campaign ready. ID: ${campaignId}`);
  return { campaignId, webId, subject, testSent, testEmails };
}

function getMailchimpDc() {
  return getDataCenter();
}

// ---------------------------------------------------------------------------
// Legacy template helpers (kept for compatibility; not used by the draft flow)
// ---------------------------------------------------------------------------

async function getMasterTemplateHtml() {
  const masterId = (process.env.MAILCHIMP_MASTER_TEMPLATE_ID || "").trim();
  if (!masterId) {
    const err = new Error("MAILCHIMP_MASTER_TEMPLATE_ID environment variable is not set");
    err.code = "master_id_missing";
    throw err;
  }
  const data = await mc(`/templates/${masterId}/default-content`, { notFoundCode: "master_not_found" });
  const html = data && data.html ? data.html.trim() : "";
  if (!html || html.length < 100) {
    const err = new Error("Master template HTML is empty or too short.");
    err.code = "master_html_empty";
    throw err;
  }
  return html;
}

async function createMailchimpTemplate(name, html) {
  const data = await mc("/templates", { method: "POST", body: { name, html } });
  if (!data || !data.id) {
    const err = new Error("Mailchimp POST /templates response missing template ID");
    err.code = "bad_request";
    throw err;
  }
  return { templateId: data.id, templateName: data.name || name };
}

module.exports = {
  createCampaignDraft,
  getMailchimpDc,
  getMasterTemplateHtml,
  createMailchimpTemplate,
};
