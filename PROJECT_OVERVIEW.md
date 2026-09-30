# 📦 Telegram Product & Inventory Bot — Project Overview

> **Version**: 1.0.0  
> **Platform**: Node.js Serverless (Vercel) + Telegram Bot API + Firebase Firestore  
> **Primary Use Case**: Automated Product Data Scraping, Multi-channel Deal Formatting, and Inventory Deal Excel Generation for Liquidation / Closeout Arbitrage.

---

## 🚀 Executive Summary

The **Telegram Product Bot** is an automated backend service and bot designed to streamline wholesale, liquidation, and arbitrage deal processing. 

By sending Amazon or Walmart product links accompanied by pricing, quantity, expiration, and location details into Telegram, users immediately receive:
1. **Multi-Channel Deal Formatting**: Pre-formatted snippets ready to publish on **Mail campaigns**, **LinkedIn B2B posts**, or **Website catalogs**.
2. **Dynamic Output Customization**: An interactive Telegram inline checkbox interface to selectively show or hide any field (e.g. Title, Brand, UPC, ASIN, Price, Quantity, Link, Photo).
3. **Automated Wholesale Excel Generation**: When wholesale deals (containing retail values and asking prices) are submitted, the bot computes unit pricing, aggregates totals, generates an enterprise-grade `.xlsx` spreadsheet with custom styling and formulas, and transmits the workbook with a summary directly inside Telegram.

---

## 🏗️ Technical Architecture & Workflow

### 1. Webhook Lifecycle
```
Telegram User ──> Telegram Server ──> POST /api/webhook (Vercel Function)
                                            │
                                            ├── 1. Deduplication check via Firestore `processedUpdates`
                                            │      (Drops Telegram retry loops)
                                            │
                                            ├── 2. Command / Callback Handling:
                                            │      - `/start`: Display mode selection (Mail / LinkedIn / Website)
                                            │      - `callback_query`: Interactive field toggles (check/uncheck)
                                            │
                                            ├── 3. Message Classification:
                                            │      ├── [Branch A] Wholesale / Inventory Message:
                                            │      │     └── Trigger `handleInventoryMessage()`
                                            │      │         ├── Fast 200 OK acknowledgment to Telegram
                                            │      │         ├── Parallel multi-product scraping with retries
                                            │      │         ├── Retail price allocation for missing items
                                            │      │         ├── Excel generation (`ExcelJS`)
                                            │      │         ├── `sendDocument` (.xlsx file)
                                            │      │         └── Markdown summary of retail vs asking margin
                                            │      │
                                            │      └── [Branch B] Standard Product Deal Message:
                                            │            ├── Parallel scraping (`Promise.all`)
                                            │            ├── Retrieve user's configured mode & active fields
                                            │            └── `sendPhoto` / `sendMessage` formatted replies
```

---

## 🔍 Data Scraping & Extraction Hierarchy

| Priority Tier | Target Engine | Capabilities & Notes |
|:---:|:---|:---|
| **Tier 1** | **ScraperAPI Structured Amazon API** | Directly queries `https://api.scraperapi.com/structured/amazon/product?asin=...`. Returns clean JSON containing name, brand, high-res images, pricing, and UPCs without hitting Amazon's anti-bot/CAPTCHAs. |
| **Tier 2** | **Walmart Next.js State Extraction** | Extracts `<script id="__NEXT_DATA__">` JSON blob containing deep initial product state, images, UPC barcodes, and live prices without client-side JS overhead. |
| **Tier 3** | **Structured Data (JSON-LD)** | Parses `script[type="application/ld+json"]` tags using a 2-pass strategy (prioritizing `@type: Product`, ignoring navigation/search breadcrumbs). |
| **Tier 4** | **Targeted HTML DOM Fallbacks** | Robust Cheerio CSS selectors targeting buybox elements (`.priceToPay`, `#landingImage`, `#detailBullets_feature_div`, `data-a-dynamic-image`, `bylineInfo`). |
| **Tier 5** | **UPCItemDB External API Lookup** | If UPC is missing from Amazon/Walmart listing, searches `https://api.upcitemdb.com/prod/trial/search?s=...` using sanitized product name. |

---

## 🎛️ Modes & Field Customization

Users configure their preferences using interactive inline keyboards:

```
[ ✅ Product Name ]  [ ✅ Price        ]
[ ✅ Units        ]  [ ✅ UPC          ]
[ ✅ Link         ]  [ ✅ Image        ]
[ ☑️ All / ⬜ None                     ]
[ ↩️ Change Mode   ]  [ ✔️ Done          ]
```

### Supported Modes:
- **📧 Mail Mode**: Generates ready-to-send marketing email formats with subject lines, quantities, unit prices, expiry dates, FOB locations, and images.
- **💼 LinkedIn Mode**: Produces concise B2B posts highlighting UPC, price, quantities, links, and product photos.
- **🌐 Website Mode**: Full metadata catalog listing containing ASIN, UPC, clean titles, prices, and links.

---

## 📊 Wholesale Excel Generator Specifications

When a wholesale/liquidation deal is detected, an `.xlsx` file (`inventory_deal.xlsx`) is automatically generated:

- **Row 1**: Blank spacing row.
- **Row 2 (Header)**: Branded Navy Fill (`#1F497D`), white bold text, centered:
  `Product Name | Retail Price | Unit | UPC Code | ASIN Code | Product Link | Total Price`
- **Data Rows**:
  - Zebra striping with alternating soft blue (`#DCE6F1`) and white (`#FFFFFF`) fills.
  - Number formatting: Currency (`$#,##0.00`) and Units (`#,##0`).
  - Active clickable blue hyperlinks directly pointing to original product listings.
- **Totals Section**:
  - 3 blank spacing rows.
  - **TOTAL Row**: Highlighted in soft gold/yellow (`#FFE599`), bold summary of units and extended retail values.
  - **Asking Price Row**: Displays buyer's asking price.

---

## 📁 Repository Map

- [api/webhook.js](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/api/webhook.js): Complete webhook listener, parser, scraping engine, Excel generator, and Telegram dispatcher.
- [public/index.html](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/public/index.html): Health-check landing page for the Vercel deployment.
- [package.json](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/package.json): Node project manifest and dependency definitions.
- [vercel.json](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/vercel.json): Vercel configuration specifying 300-second maximum duration.
- [README.md](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/README.md): Full documentation, configuration guide, and setup instructions.
- [PROJECT_OVERVIEW.md](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram%20bot/PROJECT_OVERVIEW.md): Executive summary and technical blueprint.

---

## 🔑 Required Credentials

1. **Telegram**: Bot Token from `@BotFather`.
2. **Firebase Firestore**: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
3. **ScraperAPI**: `SCRAPER_API_KEY` (for residential proxy rotation and structured Amazon product API).
