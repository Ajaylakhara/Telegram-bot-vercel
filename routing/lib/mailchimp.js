/**
 * Mailchimp API client -- template operations only.
 *
 * Exports:
 *   getMasterTemplateHtml()               -> string (full HTML of master template)
 *   createMailchimpTemplate(name, html)   -> { templateId, templateName }
 *
 * Error contract: all functions throw an Error with a `.code` string property.
 * Callers must use try/catch and map err.code to a user-facing message.
 *
 * GUARANTEES:
 *   - Master template is NEVER modified (only GET is called on it)
 *   - POST /campaigns is NEVER called
 *   - API key is NEVER logged or returned to the user
 */

"use strict";

const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHeaders() {
  const apiKey = (process.env.MAILCHIMP_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("MAILCHIMP_API_KEY environment variable is not set");
    err.code = "config_missing";
    throw err;
  }
  const encoded = Buffer.from(`anystring:${apiKey}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
  };
}

function getDataCenter() {
  const apiKey = (process.env.MAILCHIMP_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("MAILCHIMP_API_KEY environment variable is not set");
    err.code = "config_missing";
    throw err;
  }
  const dc = apiKey.split("-").pop();
  if (!dc || dc === apiKey) {
    const err = new Error("MAILCHIMP_API_KEY appears malformed -- expected format: key-dcXX");
    err.code = "config_missing";
    throw err;
  }
  return dc;
}

async function mailchimpFetch(url, options = {}, attempt = 1) {
  let response;
  try {
    response = await fetch(url, { timeout: 15000, ...options });
  } catch (networkErr) {
    const err = new Error(`Network error: ${networkErr.message}`);
    err.code = "network_error";
    throw err;
  }

  if (response.status === 429 && attempt === 1) {
    console.warn("[MAILCHIMP] Rate limited (429), retrying after 1s...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return mailchimpFetch(url, options, 2);
  }

  if (response.status === 401) {
    const err = new Error("Mailchimp authentication failed (401)");
    err.code = "auth_failed";
    throw err;
  }

  if (response.status === 404) {
    const err = new Error("Mailchimp resource not found (404)");
    err.code = "master_not_found";
    throw err;
  }

  if (response.status === 429) {
    const err = new Error("Mailchimp rate limit exceeded after retry");
    err.code = "rate_limited";
    throw err;
  }

  if (response.status === 400) {
    const body = await response.text();
    const err = new Error(`Mailchimp bad request (400): ${body}`);
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

  return response.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function getMasterTemplateHtml() {
  const masterId = (process.env.MAILCHIMP_MASTER_TEMPLATE_ID || "").trim();
  if (!masterId) {
    const err = new Error("MAILCHIMP_MASTER_TEMPLATE_ID environment variable is not set");
    err.code = "master_id_missing";
    throw err;
  }

  const dc = getDataCenter();
  const headers = buildHeaders();
  const url = `https://${dc}.api.mailchimp.com/3.0/templates/${masterId}/default-content`;

  console.log(`[MAILCHIMP] Fetching master template HTML (ID: ${masterId})`);

  const data = await mailchimpFetch(url, { method: "GET", headers });

  const html = (data && data.html) ? data.html.trim() : "";

  if (!html || html.length < 100) {
    const err = new Error(
      "Master template HTML is empty or too short. " +
      "Ensure the master template is a Classic/custom-coded template, not a New Builder template."
    );
    err.code = "master_html_empty";
    throw err;
  }

  console.log(`[MAILCHIMP] Master template HTML fetched (${html.length} chars)`);
  return html;
}

async function createMailchimpTemplate(name, html) {
  const dc = getDataCenter();
  const headers = buildHeaders();
  const url = `https://${dc}.api.mailchimp.com/3.0/templates`;

  console.log(`[MAILCHIMP] Creating new template: "${name}" (${html.length} chars)`);

  const data = await mailchimpFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, html }),
  });

  if (!data || !data.id) {
    const err = new Error("Mailchimp POST /templates response missing template ID");
    err.code = "bad_request";
    throw err;
  }

  console.log(`[MAILCHIMP] Template created successfully. ID: ${data.id}`);
  return { templateId: data.id, templateName: data.name || name };
}

function getMailchimpDc() {
  return getDataCenter();
}

module.exports = { getMasterTemplateHtml, createMailchimpTemplate, getMailchimpDc };
