// Fallback loader for .env — only used when process.env.BOT_TOKEN isn't already
// populated by the platform (e.g. local `vercel dev` without Vercel's own env
// injection). In production on Vercel, env vars are injected directly and this
// block is a no-op.
//
// Required env vars:
//   BOT_TOKEN                   - Telegram bot token
//   TELEGRAM_WEBHOOK_SECRET     - (optional) webhook secret for extra security
//   ALLOWED_CHAT_IDS            - (optional) comma-separated allowed chat IDs
//   FIREBASE_PROJECT_ID         - Firebase project
//   FIREBASE_CLIENT_EMAIL       - Firebase service account email
//   FIREBASE_PRIVATE_KEY        - Firebase service account private key
//   SCRAPER_API_KEY             - ScraperAPI key for product scraping
//   MAILCHIMP_API_KEY           - Mailchimp API key
//   MAILCHIMP_LIST_ID           - Mailchimp audience list ID
//   MAILCHIMP_MASTER_CAMPAIGN_ID- Mailchimp master campaign to clone
//   MAILCHIMP_TEST_EMAILS       - (optional) comma-separated test email recipients
//   SITE_URL                    - Laravel site base URL (e.g. https://thecloseoutcenter.com)
//   SITE_API_SECRET             - x-api-key header value for the Laravel bot API
if (!process.env.BOT_TOKEN) {
  try {
    const fs = require("fs");
    const path = require("path");
    const envPath = path.resolve(__dirname, "../../.env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          let value = (match[2] || "").trim();
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          if (!process.env[key]) process.env[key] = value;
        }
      }
    }
  } catch (_) {
    // Silent — if this fails, the platform's own env injection is the source of truth.
  }
}

module.exports = {};