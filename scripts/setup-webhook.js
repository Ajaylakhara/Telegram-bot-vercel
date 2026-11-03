/**
 * setup-webhook.js
 * 
 * Run this script to:
 * 1. Check the current webhook status
 * 2. Re-register the webhook with the correct Vercel URL
 * 3. Verify the bot token works
 * 
 * Usage: node scripts/setup-webhook.js
 * Or to force re-register: node scripts/setup-webhook.js --force
 */

require("../routing/lib/env");
const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN is not set. Check your .env file.");
  process.exit(1);
}

const WEBHOOK_URL = process.env.WEBHOOK_URL ||
  "https://telegram-product-bot-ecru.vercel.app/api/webhook";

function apiCall(method, data = null) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: data ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let rawData = "";
      res.on("data", (chunk) => (rawData += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(rawData)); }
        catch { resolve({ ok: false, raw: rawData }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const forceRegister = process.argv.includes("--force");
  
  console.log("🔍 Telegram Bot Webhook Diagnostic\n" + "=".repeat(40));
  
  // 1. Check bot identity
  console.log("\n1️⃣  Checking bot token...");
  const me = await apiCall("getMe");
  if (!me.ok) {
    console.error("❌ Bot token is INVALID or revoked:", me.description);
    process.exit(1);
  }
  console.log(`✅ Bot: @${me.result.username} (${me.result.first_name})`);

  // 2. Check current webhook
  console.log("\n2️⃣  Checking current webhook...");
  const info = await apiCall("getWebhookInfo");
  if (info.ok) {
    const wh = info.result;
    console.log("   URL:", wh.url || "(none)");
    console.log("   Pending updates:", wh.pending_update_count);
    console.log("   Last error:", wh.last_error_message || "(none)");
    console.log("   Last error date:", wh.last_error_date
      ? new Date(wh.last_error_date * 1000).toISOString()
      : "(none)");
    
    if (wh.url === WEBHOOK_URL && !forceRegister) {
      console.log("\n✅ Webhook is already correctly registered.");
      console.log("   If the bot is still not responding, the issue is likely:");
      console.log("   → Missing or incorrect env vars in Vercel dashboard");
      console.log(`   → Check: ${WEBHOOK_URL}`);
      console.log("   → Open that URL in browser to see health status JSON");
    } else {
      await registerWebhook();
    }
  } else {
    console.error("❌ Could not get webhook info:", info.description);
  }

  // 3. Check env vars
  console.log("\n3️⃣  Checking environment variables...");
  const envVars = {
    BOT_TOKEN: !!process.env.BOT_TOKEN,
    FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: (process.env.FIREBASE_PRIVATE_KEY || "").length > 100,
    SCRAPER_API_KEY: !!process.env.SCRAPER_API_KEY,
    MAILCHIMP_API_KEY: !!process.env.MAILCHIMP_API_KEY,
    MAILCHIMP_LIST_ID: !!process.env.MAILCHIMP_LIST_ID,
    SITE_URL: !!process.env.SITE_URL,
    SITE_API_SECRET: !!process.env.SITE_API_SECRET,
  };
  
  let allSet = true;
  for (const [key, ok] of Object.entries(envVars)) {
    console.log(`   ${ok ? "✅" : "❌"} ${key}`);
    if (!ok) allSet = false;
  }
  
  if (!allSet) {
    console.log("\n⚠️  Some env vars are missing. Make sure ALL these are set in:");
    console.log("   Vercel Dashboard → Your Project → Settings → Environment Variables");
    console.log("\n   Critical ones: BOT_TOKEN, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,");
    console.log("   FIREBASE_PRIVATE_KEY (must include the full -----BEGIN PRIVATE KEY----- block)");
  }
}

async function registerWebhook() {
  console.log(`\n📡 Registering webhook: ${WEBHOOK_URL}`);
  const result = await apiCall("setWebhook", {
    url: WEBHOOK_URL,
    allowed_updates: ["message", "callback_query"],
  });
  if (result.ok) {
    console.log("✅ Webhook registered successfully!");
  } else {
    console.error("❌ Failed to register webhook:", result.description);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
