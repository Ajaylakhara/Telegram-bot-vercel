# Mailchimp Template Integration Plan — v3

> **Status**: Planning Only — No code written. No project files modified.
> **Project**: Telegram Product & Inventory Bot (Node.js / Vercel / Firebase)
> **Feature**: Mailchimp Email Template Generator — CREATE ONLY, NO email sending
> **Version**: 3

---

## v3 Changelog (changes from v2)

| # | Section | Change |
|---|---|---|
| 1 | Q1 / Q2 / Q4 | Rewritten as **UNVERIFIED**. `GET /default-content` returns `mc:edit` sections, NOT guaranteed full HTML. First task of Phase 0 is a real API call to verify. |
| 2 | Q4 / Section 3 | **Option B promoted to PRIMARY** if Phase 0 test shows HTML not returned. Both options fully planned with file location, sync process, README note. |
| 3 | Q1 | Added: `POST /templates` supports **Classic templates only** (verified). |
| 4 | Section 3 / Section 5 / Phase 5 | Architecture fixed: `mode === "mail"` check and `res.status(200)` moved **BEFORE** `Promise.all(scrapeProduct)`. Contradiction removed. |
| 5 | Section 17 / Phase 5 | **Vercel `waitUntil()`** from `@vercel/functions` planned for post-ack Mailchimp work. `inventory.js` production audit added. |
| 6 | Section 15 | **Full field mapping table** added: Firestore key → placeholder → section marker → disabled behavior → missing data behavior. Decision documented. |
| 7 | Section 15 | **`subject` clarified**: used only in template name, not rendered in email body. |
| 8 | Section 10 / Section 15 | All **per-field section markers** defined: `<!-- SECTION_X_START -->` / `<!-- SECTION_X_END -->` for every optional field. |
| 9 | Section 19 / Testing | **Partial scrape failure policy** defined: skip failed products, create template with rest; abort if ALL fail. |
| 10 | Section 14 | **Function replacers** mandated for all `.replace()` calls (dollar sign / special character safety). |
| 11 | Section 19 / Security | **URL escaping** pattern: `escHtml(safeUrl(url))` for `href` and `src` attributes. |
| 12 | Section 13 | **Template name**: seconds + 4-char random suffix for guaranteed uniqueness. |
| 13 | Q8 / Section 12 | **Condition**: removed default `"New"`. Omit when not provided. |
| 14 | Security | **Mailchimp merge tag neutralization**: `*|` in scraped text escaped to `*&#124;`. |
| 15 | Phase 0 | **Compliance check**: verify `*|UNSUB|*` and physical address present in master footer. |
| 16 | All sections | Removed unverified "Telegram retries within ~5s" claim. Relies on existing Firestore dedup only. |
| 17 | All API claims | Every API claim marked **Verified (source)** or **Unverified (verify in Phase 0)**. |
| 18 | Testing | 9 new test cases added (partial scrape, all-fail, `$` in price, `&` in URL, `*|` in name, empty section removal, `waitUntil` completion, compliance). |

---

## ANSWERS TO REQUIRED PRE-IMPLEMENTATION QUESTIONS

---

### Q1: Can Mailchimp retrieve a template's HTML using its template ID?

**STATUS: UNVERIFIED — must be tested in Phase 0.**

The `GET /3.0/templates/{template_id}/default-content` endpoint is documented as returning "the sections that you can edit in a template, including each section's default content" — meaning the editable `mc:edit` regions, **not necessarily a full HTML document**.

Official Mailchimp documentation confirms that this endpoint returns structured section-level content keyed by `mc:edit` attribute names, not the full raw template HTML. The API is not designed to "export" the full layout code. (Source: Mailchimp Marketing API Docs, confirmed via web search — Unverified against real master template ID.)

**Two possible outcomes when tested against the real master template:**

| Outcome | When | Approach |
|---|---|---|
| `html` field present and contains full template | Master is custom-coded, API returns full HTML | **Option A** — API-driven |
| `html` field empty, absent, or contains only partial sections | Master is drag-and-drop, or API doesn't expose full HTML | **Option B** — Static HTML in codebase |

**Phase 0 task — MUST be done before writing a single line of code:**
```bash
curl -s \
  -u "anystring:YOUR_MAILCHIMP_API_KEY" \
  "https://YOUR_DC.api.mailchimp.com/3.0/templates/YOUR_MASTER_TEMPLATE_ID/default-content" \
  | python3 -m json.tool
```
Record the exact response. If `html` contains a full `<html>...</html>` document → Option A. Otherwise → Option B.

---

### Q2: Can Mailchimp clone an existing template?

**STATUS: UNVERIFIED — verify in Phase 0.**

No dedicated `/clone` endpoint has been found in the Mailchimp Marketing API v3. The supported workaround is the "read then create" pattern (Option A). However, **whether the "read" step returns the full HTML is unverified** (see Q1). Must be confirmed in Phase 0.

---

### Q3: Can the master template be reused without modifying it?

**YES — architecturally guaranteed in both Options A and B.**

- Option A: Only `GET /templates/{MASTER_ID}/default-content` is called — read-only
- Option B: Master HTML is stored in a file — never written by the bot

The bot **never** calls `PATCH`, `PUT`, or `DELETE` on the master template ID.

---

### Q4: What is the official supported way to create a new template based on an existing one?

**STATUS: UNVERIFIED — depends on Phase 0 curl test result.**

**Option A (API-driven) — use if Phase 0 curl returns full HTML:**
```
GET /3.0/templates/{master_id}/default-content
→ { html: "<full html>", text: "..." }
→ Extract product block, inject data
→ POST /3.0/templates { name, html }
→ New template ID returned, master unchanged
```
Note: `POST /templates` supports **Classic templates only** — not the newer Mailchimp builder templates. (Verified: Mailchimp API docs confirmed this limitation.)

**Option B (Static HTML — PRIMARY if Option A fails) — use if Phase 0 curl returns no full HTML:**
```
routing/lib/masterTemplate.html       ← exported once from Mailchimp dashboard
→ Loaded at runtime by Node.js fs.readFileSync (or require/import)
→ Inject data
→ POST /3.0/templates { name, html }
→ New template ID returned, master unchanged
```

Both options produce the same result to Mailchimp. Option A avoids design drift automatically. Option B requires a sync process (documented in Section 16B).

---

### Q5: How should dynamic product blocks be inserted?

Same in both options. The master HTML (from API or file) contains:
```html
<!-- PRODUCT_BLOCK_START -->
<table>...</table>
<!-- PRODUCT_BLOCK_END -->
```
The bot extracts the block, generates N copies (one per product), and reassembles the full HTML.

---

### Q6: How should multiple products be handled?

The product block is cloned N times. Each clone is independently injected with one product's data and field mask applied. See Section 14.

---

### Q7: Where should MOQ come from?

Parser addition. Detected from `MOQ: 500`, `Min Order: 500`, etc. in Telegram message. Omitted if not present — never shown as `N/A`.

---

### Q8: Where should Condition come from?

Parser addition. Detected from `Condition: New` etc. in Telegram message. **Omitted if not provided — no default value.** Reason: never show fabricated product data. If condition is important, the user includes it in the message.

---

### Q9: Where should Expiration Date come from?

Already in the product object as `exp` from the existing parser. No change needed.

---

### Q10: Which existing fields can be directly mapped?

| Master Placeholder | Product Data Field | Source | Available? |
|---|---|---|---|
| `PLACEHOLDER_NAME` | `name` | scraper | ✅ |
| `PLACEHOLDER_BRAND` | `brand` | scraper | ✅ |
| `PLACEHOLDER_IMAGE` | `image` | scraper | ✅ |
| `PLACEHOLDER_PRICE` | `price` \|\| `scrapedPrice` formatted | parser / scraper | ✅ |
| `PLACEHOLDER_UNITS` | `units` (formatted with locale) | parser | ✅ |
| `PLACEHOLDER_UPC` | `upc` | scraper | ✅ |
| `PLACEHOLDER_ASIN` | `asin` | scraper | ✅ |
| `PLACEHOLDER_URL` | `url` | parser | ✅ |
| `PLACEHOLDER_EXP` | `exp` | parser (existing) | ✅ |
| `PLACEHOLDER_FOB` | `fob` | parser (existing) | ✅ |
| `PLACEHOLDER_MOQ` | `moq` | parser (NEW, ~3 lines) | ⚠️ Add to parser |
| `PLACEHOLDER_CONDITION` | `condition` | parser (NEW, ~3 lines) | ⚠️ Add to parser |

---

### Q11: Which fields require parser changes?

| Field | Change |
|---|---|
| `moq` | Add optional regex to `parser.js` — ~3 lines |
| `condition` | Add optional regex to `parser.js` — ~3 lines |

All other fields already exist.

---

### Q12: How can we guarantee the master template never changes?

`mailchimp.js` exports only two functions:
- `getMasterTemplateHtml()` — calls GET (read only) or loads static file
- `createMailchimpTemplate(name, html)` — calls POST /templates (creates new)

No `PATCH`, `PUT`, `DELETE`, or `/campaigns` function is defined anywhere in the codebase.

---

## 1. Existing Project Analysis

**Confirmed from actual code — not assumed.**

**Product object after parse + scrape merge (`webhook.js:105`):**
```javascript
{
  url,          // from parser
  units,        // from parser (e.g. "1200")
  price,        // from parser (e.g. "$15.50")
  exp,          // from parser (e.g. "08/2027")
  fob,          // from parser (e.g. "CA")
  name,         // from scraper
  brand,        // from scraper
  image,        // from scraper (URL string)
  upc,          // from scraper
  asin,         // from scraper
  scrapedPrice  // from scraper (numeric)
}
```

**New fields to add (parser.js — minimal additions):**
```javascript
{
  moq,       // optional — "MOQ: 500" from Telegram message
  condition  // optional — "Condition: New" from Telegram message
}
```

**Firestore field selection (mail mode — unchanged from existing code):**
```javascript
["subject", "name", "price", "units", "upc", "link", "image"]
```

---

## 2. Current Architecture (unchanged from v2)

```
Telegram POST
     ↓
api/webhook.js
     ↓
[Dedup check — Firestore processedUpdates]
     ↓
callback_query? → callbacks.js (mode/field selection)
     ↓
/start? → MODE_SELECT_KEYBOARD
     ↓
isInventoryMessage()? → inventory.js (Excel path)
     ↓
parseMultiProduct(text) → [{url, units, price, exp, fob}]
     ↓
Promise.all(scrapeProduct) → products merged
     ↓
formatCaption / sendProductReply → Telegram
```

---

## 3. New Mailchimp Architecture (FIXED — ack before scraping)

```
                         TELEGRAM POST
                               │
                               ↓
                        api/webhook.js
                               │
                   [Dedup — Firestore processedUpdates]
                               │
                        callback_query? → callbacks.js
                               │
                         /start? → menu
                               │
                    isInventoryMessage()? → inventory.js
                               │
                    parseMultiProduct(text)
                               │
              ┌────────────────┴────────────────┐
          mode === "mail"                  mode != "mail"
              │                                  │
              ↓                                  ↓
    res.status(200).send("OK")        [continue existing flow]
    [Telegram ack immediately]         Promise.all(scrapeProduct)
              │                        sendProductReply() → Telegram
              ↓
    waitUntil(mailchimpFlow())
              │
    sendMessage("🔍 Creating…")
              │
    getMasterTemplateHtml()
    [Option A: GET /templates/{MASTER_ID}/default-content]
    [Option B: fs.readFileSync(masterTemplate.html)]
              │
    Promise.all(scrapeProduct × N)     ← parallel, unchanged
              │
    [Filter: remove failed scrapes]
    [Abort if ALL failed]
              │
    generateMailchimpHTML(
      masterHtml, successfulProducts, selectedFields
    )
              │
    createMailchimpTemplate(name, html)
    POST /3.0/templates
              │
    sendMessage(chatId, confirmation)
```

**Key fix from v2**: `mode === "mail"` detected → `res.status(200)` sent → `waitUntil()` wraps all async work. Scraping happens INSIDE `waitUntil`, not before the ack.

---

## 4. User Workflow (unchanged from v2)

```
/start → field selection → user sends product URLs
  ↓
Bot: "🔍 Creating Mailchimp template for N product(s)… please wait."
  ↓ (all async work inside waitUntil)
Scrape → inject → POST to Mailchimp
  ↓
✅ Mailchimp Template Created
📧 Template: Closeout Deals — 3 Products — Oct 2 13:45:07 a3f1
📦 Products: 3 (or "2 of 3 — 1 skipped due to scrape error")
🆔 Template ID: 987654
🎨 Master ID: 123456 (unchanged)
⚠️ Email NOT sent. Template created only.
⚠️ Master template was NOT modified.
🔗 https://us19.admin.mailchimp.com/templates/
```

---

## 5. Data Flow (FIXED — ack before scraping)

```
Telegram message text
        ↓
parseMultiProduct(text)         [parser.js — add moq + condition]
        ↓
[{ url, units, price, exp, fob, moq, condition }]  ← per product
        ↓
mode === "mail" detected
res.status(200).send("OK")      ← BEFORE any async work
waitUntil(async () => {
        ↓
  getMasterTemplateHtml()       [mailchimp.js]
        ↓
  Promise.all(scrapeProduct)    [scraper.js — UNCHANGED]
        ↓
  Filter: remove failed scrapes
  If all failed → sendMessage(error) → return
        ↓
  Merge: { url,units,price,exp,fob,moq,condition,name,brand,image,upc,asin,scrapedPrice }
        ↓
  Load selectedFields from Firestore [webhook.js — already loaded before ack]
        ↓
  generateMailchimpHTML(masterHtml, products, selectedFields)
    [mailchimpTemplate.js — NEW]
        ↓
  createMailchimpTemplate(name, html)   [mailchimp.js — NEW]
        ↓
  sendMessage(chatId, confirmation)     [telegram.js — UNCHANGED]
})
```

Note: `selectedFields` and `mode` are read from Firestore BEFORE `res.status(200)` is sent (they are already available from the existing `modeDoc` query that runs before mode detection).

---

## 6. Files To Add

| File | Purpose |
|---|---|
| `routing/lib/mailchimp.js` | Mailchimp API client: get master HTML (Option A), create template, error handling |
| `routing/lib/mailchimpTemplate.js` | HTML injection: master HTML + products + selected fields → final HTML |
| `routing/lib/masterTemplate.html` | **Option B only** — exported master HTML, never modified by bot |

---

## 7. Files To Modify

| File | Change | Scope |
|---|---|---|
| `api/webhook.js` | Add Mail-mode branch BEFORE scraping; `waitUntil()` wraps async work | ~25 lines |
| `routing/lib/parser.js` | Add `moq` + `condition` optional parsing | ~8 lines |
| `package.json` | Add `@vercel/functions` dependency | 1 line |

**No changes to:**
`callbacks.js`, `format.js`, `scraper.js`, `firebase.js`, `telegram.js`, `inventory.js`, `env.js`

---

## 8. Mailchimp API Integration — Verified and Unverified Claims

| Claim | Status | Source |
|---|---|---|
| Auth: HTTP Basic, `anystring:<API_KEY>`, Base64 | **Verified** | Mailchimp Marketing API Docs |
| Base URL: `https://{dc}.api.mailchimp.com/3.0` | **Verified** | Mailchimp Marketing API Docs |
| `dc` extracted from API key suffix after last `-` | **Verified** | Mailchimp Marketing API Docs |
| `GET /templates/{id}/default-content` exists | **Verified** | Mailchimp Marketing API Docs |
| `GET /default-content` returns full HTML for custom templates | **UNVERIFIED** — test in Phase 0 | Conflicting sources |
| `POST /templates` creates a new template from HTML | **Verified** | Mailchimp Marketing API Docs |
| `POST /templates` supports Classic templates only (not New Builder) | **Verified** | Mailchimp API + third-party sources |
| No `/clone` endpoint exists for templates | **Verified** | Mailchimp API reference |
| `POST /campaigns` is NEVER called by this feature | **Guaranteed by design** | — |
| Compliance: missing `*|UNSUB|*` causes Mailchimp to append extra footer | **Verified** | Mailchimp Terms of Use Docs |

---

## 9. Environment Variables

| Variable | Description | Example |
|---|---|---|
| `MAILCHIMP_API_KEY` | Full API key — server prefix auto-extracted | `abc123def456-us19` |
| `MAILCHIMP_MASTER_TEMPLATE_ID` | Numeric ID of the master Mailchimp template | `123456` |

No third variable. DC prefix: `process.env.MAILCHIMP_API_KEY.split("-").pop()`.

**New dependency:**
```bash
npm install @vercel/functions
```
Add to `package.json` dependencies.

---

## 10. Master Template HTML Structure Requirements

The master Mailchimp template HTML MUST contain the following markers. These are added once manually in Phase 0.

### Required structural markers:

```html
<!-- PRODUCT_BLOCK_START -->
...entire repeatable product table...
<!-- PRODUCT_BLOCK_END -->
```

### Per-field section markers (every optional field needs its own pair):

```html
<!-- SECTION_IMAGE_START -->
<td><img src="PLACEHOLDER_IMAGE" ... /></td>
<!-- SECTION_IMAGE_END -->

<!-- SECTION_NAME_START -->
<td>PLACEHOLDER_NAME</td>
<!-- SECTION_NAME_END -->

<!-- SECTION_BRAND_START -->
<td>PLACEHOLDER_BRAND</td>
<!-- SECTION_BRAND_END -->

<!-- SECTION_PRICE_START -->
<td>PLACEHOLDER_PRICE</td>
<!-- SECTION_PRICE_END -->

<!-- SECTION_UNITS_START -->
<td>PLACEHOLDER_UNITS Units Available</td>
<!-- SECTION_UNITS_END -->

<!-- SECTION_MOQ_START -->
<td>MOQ: PLACEHOLDER_MOQ</td>
<!-- SECTION_MOQ_END -->

<!-- SECTION_CONDITION_START -->
<td>Condition: PLACEHOLDER_CONDITION</td>
<!-- SECTION_CONDITION_END -->

<!-- SECTION_EXP_START -->
<td>Exp: PLACEHOLDER_EXP</td>
<!-- SECTION_EXP_END -->

<!-- SECTION_FOB_START -->
<td>FOB: PLACEHOLDER_FOB</td>
<!-- SECTION_FOB_END -->

<!-- SECTION_UPC_START -->
<td>UPC: PLACEHOLDER_UPC</td>
<!-- SECTION_UPC_END -->

<!-- SECTION_ASIN_START -->
<td>ASIN: PLACEHOLDER_ASIN</td>
<!-- SECTION_ASIN_END -->

<!-- SECTION_LINK_START -->
<td><a href="PLACEHOLDER_URL">View Product</a></td>
<!-- SECTION_LINK_END -->
```

**Rule:** If a field is disabled by the user OR its data value is empty/missing → **remove the entire section** (no empty `<td>`, no empty `<img src="">`, no broken labels).

### Compliance (required in master footer — verify in Phase 0):
```html
<a href="*|UNSUB|*">Unsubscribe</a>
*|LIST:ADDRESS|*
```

---

## 11. Field Mapping — Complete Table

| Firestore key | Placeholder | Section Marker | When disabled (Firestore) | When data missing |
|---|---|---|---|---|
| `name` | `PLACEHOLDER_NAME` | `SECTION_NAME` | Remove section | Remove section |
| `image` | `PLACEHOLDER_IMAGE` | `SECTION_IMAGE` | Remove section | Remove section (no broken img) |
| `price` | `PLACEHOLDER_PRICE` | `SECTION_PRICE` | Remove section | Remove section |
| `units` | `PLACEHOLDER_UNITS` | `SECTION_UNITS` | Remove section | Remove section |
| `upc` | `PLACEHOLDER_UPC` | `SECTION_UPC` | Remove section | Remove section |
| `link` | `PLACEHOLDER_URL` | `SECTION_LINK` | Remove section | Remove section |
| `subject` | *(none — see below)* | *(none)* | Template name still generated | — |

**Fields in master template NOT in Firestore mail field selection (shown when data present, hidden when missing):**

| Placeholder | Section Marker | Controlled by | When data missing |
|---|---|---|---|
| `PLACEHOLDER_BRAND` | `SECTION_BRAND` | Presence of `brand` value | Remove section |
| `PLACEHOLDER_EXP` | `SECTION_EXP` | Presence of `exp` value | Remove section |
| `PLACEHOLDER_FOB` | `SECTION_FOB` | Presence of `fob` value | Remove section |
| `PLACEHOLDER_MOQ` | `SECTION_MOQ` | Presence of `moq` value | Remove section |
| `PLACEHOLDER_CONDITION` | `SECTION_CONDITION` | Presence of `condition` value | Remove section |
| `PLACEHOLDER_ASIN` | `SECTION_ASIN` | Presence of `asin` value | Remove section |

---

## 12. Field Selection — Design Decision

**Decision: Do NOT add `moq`, `condition`, `exp`, `fob`, `brand`, `asin` to `MODE_FIELDS["mail"]`.**

**Reason**: Adding them to `MODE_FIELDS` would require modifying `callbacks.js`, `format.js`, and re-testing all existing field-toggle behavior. This is significant scope creep for Phase 1.

**Instead**: These extra fields are controlled exclusively by whether the data is present:
- If `product.moq` is truthy → show `SECTION_MOQ`
- If `product.moq` is falsy → remove `SECTION_MOQ`
- Same pattern for `condition`, `exp`, `fob`, `brand`, `asin`

The existing Firestore field selection (`name`, `price`, `units`, `upc`, `link`, `image`) continues to control those fields exactly as today.

**Future consideration**: In a later phase, all mail fields (including the new ones) can be added to `MODE_FIELDS["mail"]` with a UI toggle. That requires a Phase 2 `callbacks.js` update.

---

## 13. Subject Field — Clarification

`subject` is a **Telegram caption setting**, not an email template body field.

In Mailchimp, the "subject line" belongs to a **Campaign**, not a Template. Since Phase 1 creates templates only (no campaigns), `subject` is used ONLY to generate the **template name**:

```javascript
// Template name uses brand/name from first product + count + timestamp
const brand = products[0]?.brand || products[0]?.name || "Closeout Deal";
const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const templateName = products.length === 1
  ? `${brand} — ${ts} ${rand}`
  : `Closeout Deals — ${products.length} Products — ${ts} ${rand}`;
```

`subject` does NOT appear in the rendered email body. It is NOT used for `<!-- SECTION_SUBJECT_START -->`. This resolves the ambiguity.

---

## 14. Multiple Product Handling (FIXED — function replacers)

```javascript
function generateMailchimpHTML(masterHtml, products, selectedFields) {
  const sel = new Set(selectedFields);
  const blockRegex = /<!-- PRODUCT_BLOCK_START -->([\s\S]*?)<!-- PRODUCT_BLOCK_END -->/;
  const blockMatch = masterHtml.match(blockRegex);
  if (!blockMatch) throw { error: "marker_missing" };

  const blockTemplate = blockMatch[1];

  // Generate one block per product — same design, different data
  const productBlocks = products.map(p => injectProductData(blockTemplate, p, sel));

  // Replace the single master block with N product blocks
  return masterHtml.replace(
    blockRegex,
    () => productBlocks.join("\n<!-- PRODUCT_DIVIDER -->\n")
    // ↑ Function replacer prevents $ in values from being interpreted as replacement patterns
  );
}

function injectProductData(blockHtml, product, sel) {
  let html = blockHtml;
  const { name, brand, image, price, scrapedPrice, units, upc, asin,
          url, exp, fob, moq, condition } = product;

  // 1. Remove disabled / empty sections first
  const effectivePrice = price || (scrapedPrice ? `$${scrapedPrice}` : null);
  const fmtUnits = units ? Number(units).toLocaleString("en-US") : null;

  // Firestore-controlled fields
  if (!sel.has("image") || !safeImageUrl(image)) html = removeSection(html, "IMAGE");
  if (!sel.has("name") || !name) html = removeSection(html, "NAME");
  if (!sel.has("price") || !effectivePrice) html = removeSection(html, "PRICE");
  if (!sel.has("units") || !fmtUnits) html = removeSection(html, "UNITS");
  if (!sel.has("upc") || !upc) html = removeSection(html, "UPC");
  if (!sel.has("link") || !url) html = removeSection(html, "LINK");

  // Data-presence-controlled fields (no Firestore toggle)
  if (!brand) html = removeSection(html, "BRAND");
  if (!exp) html = removeSection(html, "EXP");
  if (!fob) html = removeSection(html, "FOB");
  if (!moq) html = removeSection(html, "MOQ");
  if (!condition) html = removeSection(html, "CONDITION");
  if (!asin) html = removeSection(html, "ASIN");

  // 2. Inject remaining data — FUNCTION REPLACERS (safe for $ in prices, & in URLs)
  const safe = (v) => escHtml(neutralizeMergeTags(String(v || "")));
  const safeAttr = (v) => escHtml(safeUrl(String(v || "")));
  // safeAttr: validates URL protocol AND escapes & → &amp; for HTML attribute context

  html = html
    .replace(/PLACEHOLDER_NAME/g, () => safe(name))
    .replace(/PLACEHOLDER_BRAND/g, () => safe(brand))
    .replace(/PLACEHOLDER_PRICE/g, () => safe(effectivePrice))
    .replace(/PLACEHOLDER_UNITS/g, () => safe(fmtUnits))
    .replace(/PLACEHOLDER_UPC/g, () => safe(upc))
    .replace(/PLACEHOLDER_ASIN/g, () => safe(asin))
    .replace(/PLACEHOLDER_EXP/g, () => safe(exp))
    .replace(/PLACEHOLDER_FOB/g, () => safe(fob))
    .replace(/PLACEHOLDER_MOQ/g, () => safe(moq))
    .replace(/PLACEHOLDER_CONDITION/g, () => safe(condition))
    .replace(/PLACEHOLDER_URL/g, () => safeAttr(url))
    .replace(/PLACEHOLDER_IMAGE/g, () => safeAttr(image));

  return html;
}

function removeSection(html, sectionId) {
  const re = new RegExp(
    `<!-- SECTION_${sectionId}_START -->[\\s\\S]*?<!-- SECTION_${sectionId}_END -->`,
    "g"
  );
  return html.replace(re, () => "");
  // ↑ Function replacer — avoids special $ replacement behavior
}
```

---

## 15. Partial Scrape Failure Policy (NEW in v3)

### When 1 of N products fails to scrape:

**Policy: Skip the failed product, create the template with the remaining successful products.**

Rationale: Creating a partial template is more useful than aborting entirely. The user is informed clearly which products were skipped.

```javascript
const results = await Promise.all(
  products.map(async (p) => {
    try {
      const info = await scrapeProduct(p.url);
      return { ...p, ...info, _ok: true };
    } catch (e) {
      console.error(`[MAILCHIMP] Scrape failed for ${p.url}: ${e.message}`);
      return { ...p, _ok: false };
    }
  })
);

const successful = results.filter(r => r._ok);
const failed = results.filter(r => !r._ok);
```

### When ALL products fail to scrape:

**Policy: Abort. Send a clear error message. Do not create a template.**

```javascript
if (successful.length === 0) {
  await sendMessage(chatId,
    `❌ Could not scrape any products.\nNo Mailchimp template was created.`
  );
  return;
}
```

### Telegram confirmation when some products are skipped:

```
✅ Mailchimp Template Created

📧 Template: Closeout Deals — 2 Products — Oct 2 13:45:07 a3f1
📦 Products: 2 of 3 created
⚠️ 1 product skipped (scrape failed):
   • https://www.amazon.com/dp/BADURL

🆔 Template ID: 987654
🎨 Master ID: 123456 (unchanged)
⚠️ Email NOT sent. Template created only.
```

---

## 16. Option B — Static HTML Master Template (Full Plan)

If Phase 0 confirms Option A does not return full HTML, Option B becomes the PRIMARY approach.

### File location:
```
routing/lib/masterTemplate.html
```

### File header comment (required):
```html
<!--
  MAILCHIMP MASTER TEMPLATE — STATIC COPY
  Master Template ID: 123456
  Last exported: 2026-10-02
  Last updated in Mailchimp: [update this date if master is changed]

  HOW TO SYNC:
  1. Log in to Mailchimp
  2. Go to Templates → [Master Template Name]
  3. Edit → Export HTML (or copy source from editor)
  4. Replace this file's content with the new HTML
  5. Update "Last exported" and "Last updated in Mailchimp" dates above
  6. Commit with message: "sync: update masterTemplate.html from Mailchimp [date]"

  IMPORTANT: This file is READ ONLY at runtime. The bot never writes to it.
-->
```

### `getMasterTemplateHtml()` for Option B:
```javascript
const path = require("path");
const fs = require("fs");

function getMasterTemplateHtml() {
  const filePath = path.join(__dirname, "masterTemplate.html");
  const html = fs.readFileSync(filePath, "utf8");
  if (!html || html.length < 100) throw { error: "master_html_empty" };
  return html;
}
```

### Design drift prevention:
- The file header documents the master template ID and sync date
- README must include: "When the master Mailchimp template is updated, export the HTML and update `routing/lib/masterTemplate.html`"
- Add a lint check or pre-deploy reminder in `README.md`

### `.gitignore` considerations:
`masterTemplate.html` must be committed to the repository (unlike `.env`). It contains no secrets.

---

## 17. Vercel `waitUntil()` — Background Execution Plan

### Why it is needed:

On Vercel serverless functions, work executed after `res.status(200).send("OK")` in a standard Node.js HTTP handler is **not guaranteed to complete**. The function runtime may be terminated as soon as the response is sent.

`waitUntil()` from `@vercel/functions` explicitly extends the function lifetime until the provided Promise settles.

**Important limitation (verified)**: `waitUntil` is "best-effort" — it extends the lifetime but does not retry on failure. If Vercel terminates the function due to `maxDuration` being reached, the background work stops. For this use case (single template creation, <30s total), this is acceptable.

### Implementation in `webhook.js`:
```javascript
const { waitUntil } = require("@vercel/functions");

// In the mail-mode branch:
if (mode === "mail") {
  res.status(200).send("OK");  // immediate ack to Telegram
  waitUntil(
    (async () => {
      try {
        await sendMessage(chatId, `🔍 Creating Mailchimp template for ${products.length} product(s)…`);
        // ... getMasterTemplateHtml, scrape, generate, createTemplate, sendConfirmation
      } catch (err) {
        console.error("[MAILCHIMP] Unhandled error in waitUntil:", err);
        await sendMessage(chatId, "❌ An unexpected error occurred creating the Mailchimp template.").catch(() => {});
      }
    })()
  );
  return;
}
```

### `inventory.js` audit (required in Phase 0):

The existing `inventory.js` uses the same pattern without `waitUntil`:
```javascript
// webhook.js line 94 (current)
res.status(200).send("OK");
await handleInventoryMessage(chatId, message);
```

**Phase 0 task**: Verify in production whether `handleInventoryMessage` reliably completes after `res.status(200)` on Vercel. If there are reports of incomplete Excel generation or missing Telegram replies, apply `waitUntil` to the inventory path as well using the same pattern.

### New dependency:
```json
"@vercel/functions": "^1.0.0"
```

---

## 18. Security

| Risk | Mitigation |
|---|---|
| API key in logs | Never `console.log` `MAILCHIMP_API_KEY` — log only `[MAILCHIMP] status` |
| API key in Telegram | Never included in any user-facing message |
| Scraped text HTML injection | `escHtml()` applied to ALL product fields |
| Mailchimp merge tag injection | `neutralizeMergeTags()` escapes `*\|` → `*&#124;` before insertion |
| Malicious image URLs | `safeImageUrl()` validates `https://` protocol; empty → section removed |
| URL injection in `href` | `safeAttr(url)` = `escHtml(safeUrl(url))` — validates protocol + escapes `&` → `&amp;` |
| Dollar sign in replacement strings | All `.replace()` calls use function replacers — `() => value` |
| Master template accidentally PATCH'd | Module boundary: only `GET` + `POST /templates` in `mailchimp.js` |
| `.env` committed | Already in `.gitignore` |
| `masterTemplate.html` secrets | File contains no secrets — safe to commit |

### Security utilities (`mailchimpTemplate.js`):
```javascript
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    if (!["https:", "http:"].includes(u.protocol)) return "#";
    return u.href; // URL.href normalizes the URL
  } catch { return "#"; }
}

function safeImageUrl(url) {
  // Returns the URL if valid https/http, null otherwise
  try {
    const u = new URL(url);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

function neutralizeMergeTags(str) {
  // Prevent scraped text from being interpreted as Mailchimp merge tags
  // *|TAG|* → *&#124;TAG&#124;*
  return str.replace(/\*\|/g, () => "*&#124;");
}

// URL attribute: validate + HTML-escape (& becomes &amp; in href/src)
const safeAttr = (url) => escHtml(safeUrl(url));
```

---

## 19. Error Handling

### `mailchimp.js` error codes:

| Error Code | Scenario | Telegram Message |
|---|---|---|
| `config_missing` | `MAILCHIMP_API_KEY` not set | ❌ Mailchimp is not configured. Contact the administrator. |
| `master_id_missing` | `MAILCHIMP_MASTER_TEMPLATE_ID` not set | ❌ Master template ID is not configured. |
| `master_not_found` | GET returns 404 | ❌ Could not load the master template. Check the template ID. |
| `master_html_empty` | HTML field empty / template is drag-and-drop type | ❌ Master template HTML is empty. Ensure it is a custom-coded Classic template. |
| `marker_missing` | `PRODUCT_BLOCK_START` not in HTML | ❌ Master template is missing product block markers. Update the master template first. |
| `all_scraped_failed` | All products failed to scrape | ❌ Could not scrape any products. No template was created. |
| `auth_failed` | Mailchimp returns 401 | ❌ Mailchimp authentication failed. Check the API key. |
| `rate_limited` | Mailchimp returns 429 (after 1 retry) | ❌ Mailchimp rate limit reached. Please try again. |
| `server_error` | Mailchimp 5xx | ❌ Mailchimp server error. Please try again. |
| `network_error` | Network timeout / exception | ❌ Could not connect to Mailchimp. Please try again. |
| `bad_request` | Mailchimp POST 400 | ❌ Could not create Mailchimp template. Please try again. |

---

## 20. Performance

```
res.status(200).send("OK")               ← immediate
        ↓ (inside waitUntil)
sendMessage("🔍 Creating…")              ← ~100ms
        ↓
getMasterTemplateHtml()                  ← Option A: ~300ms Mailchimp GET
                                           Option B: <1ms fs.readFileSync
        ↓
Promise.all(scrapeProduct × N)           ← parallel, 5–20s (scraping dominates)
        ↓
generateMailchimpHTML()                  ← sync, <10ms
        ↓
createMailchimpTemplate()                ← ~400ms Mailchimp POST
        ↓
sendMessage(confirmation)                ← ~100ms
```

Total Mailchimp overhead: ~700ms (Option A) or ~400ms (Option B) — negligible vs scraping time.

---

## 21. Testing Plan (updated — 29 test cases)

### Existing tests (carried from v2):

**Test 1** — Single Amazon, all mail fields → 1 template created with correct data
**Test 2** — 3 Amazon products → 1 template with 3 product blocks in master design
**Test 3** — Walmart product → name, image, price, UPC, link correct
**Test 4** — UPC missing from scraper → UPC section absent, no crash
**Test 5** — Image missing → image section absent, no broken `<img>`
**Test 6** — UPC disabled (Firestore) → UPC section absent from all blocks
**Test 7** — MOQ in message → appears in template
**Test 8** — MOQ not in message → MOQ section absent (never "MOQ: N/A")
**Test 9** — Condition not provided → condition section absent (no "Condition: New" default)
**Test 10** — Invalid Mailchimp API key → `❌ authentication failed` — no key exposed
**Test 11** — Wrong master template ID → `❌ could not load master template`
**Test 12** — Missing `PRODUCT_BLOCK_START` marker → `❌ master template missing markers`
**Test 13** — LinkedIn mode → unchanged sendProductReply behavior
**Test 14** — Website mode → unchanged sendProductReply behavior
**Test 15** — Inventory/wholesale → Excel generated, Mailchimp not called
**Test 16** — Duplicate webhook → Firestore dedup blocks re-processing
**Test 17** — HTML injection via product name → `&lt;script&gt;` escaped
**Test 18** — Malicious image URL → image section removed or `href="#"`
**Test 19** — Master template unchanged after run → GET confirms same name + date_created
**Test 20** — No campaign created → Mailchimp campaigns dashboard unchanged

### New tests (v3 additions):

**Test 21 — Partial scrape failure (1 of 3 fails)**
- Input: 3 URLs, middle one returns scrape error
- Expected: Template created with 2 product blocks; confirmation lists 1 skipped URL

**Test 22 — All products fail to scrape**
- Input: 3 URLs, all fail
- Expected: No template created; `❌ Could not scrape any products.` sent to Telegram

**Test 23 — Price contains `$` (dollar sign)**
- Input: product with price `$14.99`
- Expected: `$14.99` rendered correctly in email — no corruption from string replacer special char
- Verify: Template HTML contains `$14.99`, not `4.99` or `undefined`

**Test 24 — Product URL contains `&` (ampersand)**
- Input: Amazon URL with `?ref=xyz&tag=abc` in query string
- Expected: URL in `href` attribute contains `&amp;` — not raw `&`
- Verify: HTML validates; link works when clicked

**Test 25 — Product name contains `*|` (Mailchimp merge tag)**
- Input: Product name like `*|FNAME|* Edition Special`
- Expected: Rendered as `*&#124;FNAME&#124;* Edition Special` — not interpreted as merge tag
- Verify: Template preview shows escaped text; no merge tag fired

**Test 26 — Empty field section properly removed**
- Input: Product with no `fob` value
- Expected: `<!-- SECTION_FOB_START -->...<!-- SECTION_FOB_END -->` entirely removed from HTML
- Verify: Generated HTML contains no empty `<td>`, no "FOB: ", no broken rows

**Test 27 — `waitUntil` completes before function termination**
- Input: Send 3 products in Mail mode
- Expected: Full Telegram confirmation message received (proves `waitUntil` ran to completion)
- Note: This is a production integration test — observe actual Vercel function logs

**Test 28 — Compliance markers present in master template**
- Phase 0 check: verify `*|UNSUB|*` is in master HTML
- Phase 0 check: verify physical address or `*|LIST:ADDRESS|*` is in master HTML
- Expected: Both present before any code is deployed

**Test 29 — Template name uniqueness**
- Input: Trigger two Mail mode requests within the same second
- Expected: Both templates created with different names (random suffix ensures uniqueness)
- Verify: Both visible in Mailchimp templates list with distinct names

---

## 22. Backward Compatibility

| Component | Status |
|---|---|
| Amazon / Walmart scraper | ✅ Unchanged |
| UPC / ASIN / image extraction | ✅ Unchanged |
| LinkedIn mode | ✅ Unchanged |
| Website mode | ✅ Unchanged |
| Inventory / Excel workflow | ✅ Unchanged (audit for `waitUntil` in Phase 0) |
| Firestore schema | ✅ No changes |
| Webhook deduplication | ✅ Unchanged |
| Field selection UI (`callbacks.js`) | ✅ Unchanged |
| `/start` command | ✅ Unchanged |
| `scraper.js` | ✅ Unchanged |
| `format.js` | ✅ Unchanged |
| `telegram.js` | ✅ Unchanged |
| `firebase.js` | ✅ Unchanged |
| `env.js` | ✅ Unchanged |

---

## 23. Implementation Phases (UPDATED)

### Phase 0 — Verification & One-time Setup (manual, before any code)

#### API Verification:
- [ ] Run Phase 0 curl against real master template ID and record exact response
- [ ] If `html` field present and ≥ 500 chars → **use Option A**
- [ ] If `html` field absent or short → **use Option B** (static HTML file)
- [ ] Verify `POST /templates` accepts the master HTML format (Classic template test)
- [ ] Confirm master template is a "Classic" / custom-coded template (not New Builder)
- [ ] Audit `inventory.js` production behavior — does work after `res.status(200)` complete reliably?

#### Compliance Check:
- [ ] Verify `*|UNSUB|*` exists in master template footer HTML
- [ ] Verify physical address or `*|LIST:ADDRESS|*` exists in master template footer
- [ ] If either is missing → add before proceeding

#### Master Template Markers (add in Mailchimp editor):
- [ ] Add `<!-- PRODUCT_BLOCK_START -->` before repeatable product section
- [ ] Add `<!-- PRODUCT_BLOCK_END -->` after repeatable product section
- [ ] Add `<!-- SECTION_IMAGE_START/END -->` around product image cell
- [ ] Add `<!-- SECTION_NAME_START/END -->` around product name cell
- [ ] Add `<!-- SECTION_BRAND_START/END -->` around brand cell
- [ ] Add `<!-- SECTION_PRICE_START/END -->` around price cell
- [ ] Add `<!-- SECTION_UNITS_START/END -->` around units cell
- [ ] Add `<!-- SECTION_MOQ_START/END -->` around MOQ cell
- [ ] Add `<!-- SECTION_CONDITION_START/END -->` around condition cell
- [ ] Add `<!-- SECTION_EXP_START/END -->` around expiration cell
- [ ] Add `<!-- SECTION_FOB_START/END -->` around FOB cell
- [ ] Add `<!-- SECTION_UPC_START/END -->` around UPC cell
- [ ] Add `<!-- SECTION_ASIN_START/END -->` around ASIN cell
- [ ] Add `<!-- SECTION_LINK_START/END -->` around CTA button cell
- [ ] Replace dynamic text with `PLACEHOLDER_*` markers
- [ ] Save and note the master template numeric ID

#### If Option B:
- [ ] Export master template HTML from Mailchimp dashboard
- [ ] Create `routing/lib/masterTemplate.html` with header comment (master ID, date, sync instructions)
- [ ] Verify no secrets in the exported HTML

### Phase 1 — Architecture Review ✅ (this document)

### Phase 2 — Parser Update
- [ ] Add `moq` parsing regex in `parser.js` (~3 lines alongside `exp`/`fob`)
- [ ] Add `condition` parsing regex in `parser.js` (~3 lines)
- [ ] Unit test both additions

### Phase 3 — Mailchimp API Module (`mailchimp.js`)
- [ ] Auth header builder (auto-extract DC prefix)
- [ ] Option A: `getMasterTemplateHtml()` — GET /default-content + validate response
- [ ] Option B: `getMasterTemplateHtml()` — fs.readFileSync
- [ ] `createMailchimpTemplate(name, html)` — POST /templates
- [ ] All error codes normalized and returned
- [ ] `[MAILCHIMP]` prefixed logs — no credential values ever logged
- [ ] 1 retry on 429 with 1s delay
- [ ] Config validation at call time

### Phase 4 — HTML Injection Module (`mailchimpTemplate.js`)
- [ ] `escHtml(str)` with all 5 characters
- [ ] `safeUrl(url)` — protocol validation
- [ ] `safeImageUrl(url)` — returns URL or null
- [ ] `neutralizeMergeTags(str)` — `*|` → `*&#124;`
- [ ] `safeAttr(url)` = `escHtml(safeUrl(url))`
- [ ] `removeSection(html, sectionId)` — function replacer
- [ ] `injectProductData(blockHtml, product, sel)` — function replacers for all placeholders
- [ ] `generateMailchimpHTML(masterHtml, products, selectedFields)` — function replacer
- [ ] `getTemplateName(products)` — seconds + 4-char random suffix

### Phase 5 — Telegram Integration (`webhook.js` — FIXED ORDER)
- [ ] Install `@vercel/functions`: `npm install @vercel/functions`
- [ ] Add `const { waitUntil } = require("@vercel/functions")`
- [ ] After `parseMultiProduct()`: detect `mode === "mail"`
- [ ] If mail mode: `res.status(200).send("OK")` immediately
- [ ] Wrap all async mail work in `waitUntil(async () => { ... })`
- [ ] Inside `waitUntil`: send "Creating…" message, getMasterHtml, scrape (parallel), filter failures, handle all-failed case, generate HTML, create template, send confirmation
- [ ] If partial failure: include skipped URLs in confirmation
- [ ] LinkedIn/Website fall through to existing `sendProductReply` (unchanged)
- [ ] If `inventory.js` audit found issue: apply `waitUntil` to inventory path too

### Phase 6 — Security Review
- [ ] Every `.replace()` call uses a function replacer `() => value`
- [ ] Every href/src injection uses `safeAttr()`
- [ ] Every text injection uses `escHtml(neutralizeMergeTags(...))`
- [ ] No `MAILCHIMP_API_KEY` appears in any log statement
- [ ] No `PATCH /templates/{MASTER_ID}` call exists anywhere
- [ ] No `POST /campaigns` call exists anywhere

### Phase 7 — Testing
- Execute all 29 test cases from Section 21

### Phase 8 — Documentation
- [ ] Update `README.md` with Mailchimp integration section
- [ ] Add both env vars to env vars table
- [ ] Document Phase 0 manual setup (markers, compliance check)
- [ ] Option B: document sync process clearly
- [ ] Explicit statement: email NOT sent, template only
- [ ] Document MOQ/Condition parsing

---

## 24. KILLCRITIC Review (updated — 12 risks)

---

### 🔴 CRITICAL: `GET /default-content` may not return full HTML (NEW in v3)

**Problem**: v2 stated as fact that this endpoint returns `{ html, text }` with full HTML. Web research now confirms this endpoint returns `mc:edit` section content, NOT necessarily a full HTML document. For drag-and-drop templates, the `html` field may be empty.

**Recommended solution**: Phase 0 curl test is the first mandatory step. Decision tree: full HTML → Option A. No full HTML → Option B (static file). Both are fully planned in this document.

---

### 🔴 CRITICAL: `POST /templates` supports Classic templates only

**Problem**: The Mailchimp API `POST /templates` endpoint does not work with the newer "New Builder" templates. If the user creates their master in the new builder, the resulting templates may not be creatable via API.

**Recommended solution**: Confirm master template type in Phase 0. If it is a New Builder template, recreate it as a Classic/custom-coded template. This is a one-time manual step.

---

### 🔴 CRITICAL: `res.status(200)` was placed after scraping in v2 architecture

**Problem**: Scraping takes 5–20 seconds. Telegram may retry. (Fixed in v3 — mode detection and `res.status(200)` moved before `Promise.all`.)

**Status**: ✅ Fixed in this document.

---

### 🔴 CRITICAL: Vercel may terminate function after `res.status(200)` without `waitUntil`

**Problem**: Work after the response is not guaranteed on Vercel serverless. Same issue potentially affects `inventory.js`.

**Recommended solution**: `waitUntil()` from `@vercel/functions` planned for mail mode. `inventory.js` production audit planned in Phase 0. (Fixed in v3.)

---

### 🔴 CRITICAL: Dollar sign in `.replace()` replacement strings

**Problem**: JavaScript's `str.replace(/PATTERN/g, value)` treats `$` in `value` as a special character (`$1`, `$&`, `$'`, etc.). A price like `$14.99` would produce corrupted output.

**Recommended solution**: All `.replace()` calls use function replacers: `.replace(/PLACEHOLDER_X/g, () => value)`. The function's return value is NOT parsed for `$` patterns. (Fixed in v3.)

---

### 🔴 CRITICAL: `&` in URLs inside `href`/`src` attributes

**Problem**: A product URL like `https://amazon.com/dp/B08?ref=abc&tag=xyz` contains `&`. Inserting it raw into an HTML `href` attribute creates invalid HTML (`&` must be `&amp;` in attribute context).

**Recommended solution**: `safeAttr(url) = escHtml(safeUrl(url))` — `safeUrl` normalizes the URL, `escHtml` converts `&` → `&amp;` for the attribute context. (Fixed in v3.)

---

### 🟡 MEDIUM: Mailchimp merge tag injection via product names

**Problem**: If a scraped product name contains `*|FNAME|*` or any Mailchimp merge tag syntax, Mailchimp may attempt to evaluate it when the template is previewed or the email is sent.

**Recommended solution**: `neutralizeMergeTags(str)` escapes `*|` → `*&#124;` before any product text is inserted. (Fixed in v3.)

---

### 🟡 MEDIUM: Condition defaulting to "New" was misleading

**Problem**: v2 added a default of `"New"` for condition. This would create misleading emails for any product that is NOT new, since the user might forget to specify.

**Recommended solution**: Remove the default. Condition is shown only when explicitly provided by the user in the Telegram message. (Fixed in v3.)

---

### 🟡 MEDIUM: Template name uniqueness

**Problem**: v2 said "milliseconds" but the code example only used minute-level precision. Inconsistency, and concurrent requests within the same minute would collide.

**Recommended solution**: Use seconds (`YYYY-MM-DD HH:MM:SS`) + 4-character random alphanumeric suffix. (Fixed in v3.)

---

### 🟡 MEDIUM: Compliance blocking email sending

**Problem**: If the master template does not contain `*|UNSUB|*` and a physical address, Mailchimp will append an auto-footer. While the template itself can be created without these (they're needed at campaign send time), checking now avoids surprises later.

**Recommended solution**: Phase 0 compliance check. Verify both elements exist in the master template footer before deployment. (Added in v3.)

---

### 🟢 LOW: `masterTemplate.html` sync drift (Option B only)

**Problem**: If the master Mailchimp template is updated after the static HTML file is exported, the bot generates emails based on the stale design.

**Recommended solution**: Header comment in `masterTemplate.html` documents the master template ID, export date, and sync instructions. README includes a note. Sync is manual — document clearly.

---

### 🟢 LOW: Master template modification (carried from v2)

**Problem**: Future developer could accidentally PATCH the master.

**Recommended solution**: `mailchimp.js` exports only `getMasterTemplateHtml()` and `createMailchimpTemplate()`. No update/delete functions exist. Module boundary prevents accidents.

---

## 25. Final Recommended Architecture

```
api/webhook.js                               ← MODIFIED (~25 lines)
     │
     ├── routing/lib/firebase.js             ← UNCHANGED
     ├── routing/lib/telegram.js             ← UNCHANGED
     ├── routing/lib/callbacks.js            ← UNCHANGED
     ├── routing/lib/format.js               ← UNCHANGED
     ├── routing/lib/parser.js               ← MODIFIED (~8 lines)
     ├── routing/lib/scraper.js              ← UNCHANGED
     ├── routing/lib/inventory.js            ← UNCHANGED (audit in Phase 0)
     ├── routing/lib/env.js                  ← UNCHANGED
     │
     ├── routing/lib/mailchimp.js            ← NEW
     │     getMasterTemplateHtml()           (Option A: API | Option B: fs.readFileSync)
     │     createMailchimpTemplate(name, html)
     │
     ├── routing/lib/mailchimpTemplate.js    ← NEW
     │     escHtml, safeUrl, safeImageUrl
     │     neutralizeMergeTags
     │     safeAttr = escHtml ∘ safeUrl
     │     removeSection(html, sectionId)
     │     injectProductData(block, product, sel)
     │     generateMailchimpHTML(masterHtml, products, fields)
     │     getTemplateName(products)
     │
     └── routing/lib/masterTemplate.html    ← NEW (Option B only)
           Header comment: master ID, date, sync instructions
```

### Summary of changes:

| Item | Count |
|---|---|
| New files | 2 (+ 1 if Option B) |
| Modified files | 2 (`webhook.js`, `parser.js`) |
| New `package.json` dependency | 1 (`@vercel/functions`) |
| New environment variables | 2 |
| Firestore schema changes | 0 |
| `callbacks.js` / `format.js` changes | 0 |
| Existing behavior changed | 0 |

### Non-negotiable guarantees:

```
POST /campaigns            → NEVER called
PATCH /templates/{masterId} → NEVER called
DELETE /templates/{masterId} → NEVER called
Email sending              → NEVER in Phase 1
API key in Telegram        → NEVER
Scraped text unescaped     → NEVER
$ in replacements          → NEVER (function replacers only)
& in href/src unescaped    → NEVER (safeAttr always used)
*| merge tag unescaped     → NEVER (neutralizeMergeTags always called)
Fake data (Condition: New) → NEVER shown without user input
```
