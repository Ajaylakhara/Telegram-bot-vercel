// Fallback loader for .env — only used when process.env.BOT_TOKEN isn't already
// populated by the platform (e.g. local `vercel dev` without Vercel's own env
// injection). In production on Vercel, env vars are injected directly and this
// block is a no-op.
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