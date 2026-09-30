# 🤖 Telegram Product & Inventory Bot

> An intelligent, serverless Telegram bot engineered for closeout, wholesale, and e-commerce inventory workflows. Automatically parses product links (Amazon & Walmart), extracts rich metadata (UPC, ASIN, price, brand, image, quantity), offers customizable multi-channel formatting (Email, LinkedIn, Website), and generates styled wholesale Excel deal sheets.

---

## 📑 Table of Contents
1. [Project Overview](#-project-overview)
2. [Key Features](#-key-features)
3. [System Architecture](#-system-architecture)
4. [Supported Input Formats & Workflows](#-supported-input-formats--workflows)
   - [Mode-Based Product Scraping](#1-mode-based-product-scraping-mail-linkedin-website)
   - [Automated Wholesale / Inventory Deals](#2-automated-wholesale--inventory-deals)
5. [Data Extraction & Scraping Engine](#-data-extraction--scraping-engine)
6. [Modes & Field Customization](#-modes--field-customization)
7. [Database Schema (Firebase Firestore)](#-database-schema-firebase-firestore)
8. [Tech Stack & Dependencies](#-tech-stack--dependencies)
9. [Environment Variables](#-environment-variables)
10. [Setup & Deployment](#-setup--deployment)
11. [Project Directory Structure](#-project-directory-structure)
12. [Troubleshooting & Maintenance](#-troubleshooting--maintenance)

---

## 🔍 Project Overview

The **Telegram Product Bot** acts as an automated sourcing and marketing assistant for liquidation, closeout, and retail arbitrage businesses.

Users can send Amazon or Walmart product links along with unit quantities, unit prices, asking prices, expiration dates, and FOB locations directly to the Telegram bot. The bot instantly resolves URLs, bypasses bot detections, parses structured JSON-LD and page DOMs, identifies UPC/ASIN barcodes, and outputs clean formatted messages or Excel deal sheets ready for distribution.

### Core Problems Solved:
- **Manual Data Entry Elimination**: Automatically pulls product titles, high-resolution imagery, brand names, ASINs, and UPC barcodes without manually opening links.
- **Multi-Channel Marketing Formatting**: Generates clean, ready-to-copy marketing copy tailored specifically for email campaigns, LinkedIn B2B posts, or website listings.
- **Fast Wholesale Excel Generation**: Parses complex wholesale deals with stated retail values and asking prices, builds professional zebra-striped Excel workbooks with calculated totals and margins, and sends them directly back via Telegram.
- **Serverless & Scalable**: Designed to run on Vercel Serverless Functions with Firestore deduplication to prevent duplicate webhook executions.

---

## ⚡ Key Features

- **🌐 Multi-Platform E-Commerce Scraping**:
  - Full support for **Amazon** (`amazon.com`, `a.co`, `amzn.to`) and **Walmart** (`walmart.com`).
  - Automatic shortlink redirection resolution with OCR/typo correction (e.g., `a.co/d/d` → `a.co/d/0`).
  - ScraperAPI Structured Amazon Product API integration for instant, 100% CAPTCHA-free JSON extraction.
  - Walmart Next.js state (`__NEXT_DATA__`) hydration and deep object path traversal.
  - Multi-tiered HTML/CSS selectors with anti-bot user-agent rotation.
  - Secondary fallback to UPCItemDB API for missing barcode lookups.

- **🎛️ Interactive Mode & Field Customization**:
  - **3 Distinct Pre-configured Modes**:
    - **📧 Mail**: Formatted with Subject line, Unit price, Total Units, Expiration, FOB, UPC, Link, Image.
    - **💼 LinkedIn**: Formatted for B2B network updates.
    - **🌐 Website**: Full catalog listing with ASIN and UPC metadata.
  - **Granular Field Checkboxes**: Users can dynamically enable/disable individual fields (e.g., exclude image, include only UPC & Price) via Telegram inline buttons.

- **📊 Automated Wholesale Excel & Deal Summary Generator**:
  - Automatically activates when "Retail Value" and "Asking Price" or multiple URLs with an asking price are detected.
  - Automatically estimates unit prices if scraping is blocked or items lack pricing.
  - Generates polished `.xlsx` spreadsheets styled with corporate navy blue headers, zebra striping, currency formulas, and hyperlinked URLs.
  - Computes unit sums, total calculated retail values, and percentage discounts off retail.

- **🛡️ Serverless Reliability & Deduplication**:
  - Firebase Firestore deduplication via `update_id` prevents duplicate messages caused by Telegram webhook retries on cold starts.
  - Parallel product scraping via `Promise.all` ensures rapid response times even for multi-item requests.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    User([Telegram User]) <-->|Webhook / Updates| TG[Telegram Bot API]
    TG <-->|POST /api/webhook| Vercel[Vercel Serverless Function]

    subgraph Backend [Vercel Function: api/webhook.js]
        Dedup{Check update_id in Firestore}
        Router{Message Type?}
        
        StartCmd[Mode Selection Menu]
        FieldToggle[Interactive Field Keyboard]
        InvFlow[Inventory Deal Workflow]
        StandardFlow[Multi-Product Scrape Workflow]

        Scraper[Scraping Pipeline]
        ExcelGen[ExcelJS Workbook Builder]
    end

    subgraph ExternalServices [External Integrations]
        FS[(Firebase Firestore)]
        SAPI[ScraperAPI Service]
        UPCDB[UPCItemDB API]
        AmzWm[Amazon / Walmart Web Endpoints]
    end

    Dedup -->|Duplicate| Ignore[Return 200 OK]
    Dedup -->|New| Router
    Vercel <--> FS

    Router -->|/start| StartCmd
    Router -->|Callback Query| FieldToggle
    Router -->|Wholesale deal detected| InvFlow
    Router -->|Product URLs detected| StandardFlow

    StandardFlow --> Scraper
    InvFlow --> Scraper
    Scraper --> SAPI
    Scraper --> UPCDB
    Scraper --> AmzWm

    InvFlow --> ExcelGen
    ExcelGen -->|sendDocument .xlsx| TG
    StandardFlow -->|sendMessage / sendPhoto| TG
```

---

## 📝 Supported Input Formats & Workflows

### 1. Mode-Based Product Scraping (Mail, LinkedIn, Website)
Users can send single or multiple product URLs. Pricing and unit quantities can be provided in various flexible formats:

#### Example 1: Multi-Product with Individual Quantities & Expiry
```text
https://www.amazon.com/dp/B08N5WRWNW
$15.50
1200 Units
Exp: 08/2027
FOB: CA

https://www.walmart.com/ip/123456789
$8.25
500 Units
```

#### Example 2: Shared Global Price at the End
```text
https://www.amazon.com/dp/B07XYZ1234
https://www.amazon.com/dp/B08ABC5678
$12.00
500 Units
```

#### Output Result (e.g., Mail Mode):
```text
Subject: Apple @ $15.50/unit | 1,200 Units

Product: Apple AirPods Pro (2nd Generation)
Price: $15.50
Units: 1,200
Exp: 08/2027
FOB: CA
UPC: 194253397168
Link: https://www.amazon.com/dp/B08N5WRWNW
[Attached Product Image]
```

---

### 2. Automated Wholesale / Inventory Deals
Triggered automatically whenever message text contains:
- `Retail value $X` AND `Asking price $Y` **OR**
- 2+ product links AND `Asking Price - $X`

#### Example Input:
```text
Closeout Inventory Deal:
https://www.amazon.com/dp/B08N5WRWNW 1000 Units
https://www.amazon.com/dp/B07XYZ1234 500 Units

Retail value $45,000
Asking price $12,500
```

#### Workflow & Output:
1. **Immediate Acknowledgment**: Bot notifies user: `🔍 Processing 2 product(s) for inventory deal… please wait.`
2. **Scraping & Estimation**: Fetches retail price for each item. If a product's price is obscured, estimates unit value proportionally from stated retail value.
3. **Excel Generation**: Formats and styles a custom `.xlsx` workbook:
   - **File Name**: `inventory_deal.xlsx`
   - **Headers**: `Product Name | Retail Price | Unit | UPC Code | ASIN Code | Product Link | Total Price`
   - **Styling**: Navy `#1F497D` header, alternating blue/white row fills, currency formatting, working hyperlinks.
   - **Totals & Asking Price**: Total Units, Total Calculated Retail, and Stated Asking Price.
4. **Deal Summary Telegram Message**:
   ```text
   📦 Inventory Deal Summary
   ─────────────────────────
   🔢 Total Units: 1,500
   💰 Calculated Retail Value: $45,000.00
   📊 Stated Retail: $45,000.00
   🏷️ Asking Price: $12,500.00
   💸 Discount: 72.2% off stated retail
   ```

---

## 🛠️ Data Extraction & Scraping Engine

The scraper (`scrapeProduct`) executes a hierarchical data extraction pipeline:

```mermaid
graph TD
    A[Raw URL] --> B[Resolve Shortlinks a.co, amzn.to]
    B --> C[Extract ASIN / Item ID]
    C --> D{Amazon & ASIN & ScraperAPI Key?}
    D -->|Yes| E[ScraperAPI Structured Amazon API]
    D -->|No| F[Fetch Page HTML with Rotating UAs]
    E -->|Success| G[Return Clean JSON]
    E -->|Fail / Missing UPC| H[Lookup UPC on UPCItemDB]
    F --> I{Is Walmart?}
    I -->|Yes| J[Extract __NEXT_DATA__ JSON blob]
    I -->|No| K[Parse JSON-LD application/ld+json]
    J --> L[Cheerio HTML Selectors & Meta Tags]
    K --> L
    L --> M[Fallback Scans: Regex, Buybox, Tables]
    M --> H
```

### Extraction Tiers Breakdown:
| Field | Primary Strategy | Fallback 1 | Fallback 2 | Fallback 3 |
|---|---|---|---|---|
| **Product Name** | ScraperAPI Structured API | JSON-LD `@type: Product` | Walmart `__NEXT_DATA__` | `#productTitle`, `og:title`, `<title>` |
| **UPC / Barcode** | ScraperAPI `data.upc` | JSON-LD `gtin13` / `gtin` | Walmart `item.upc` | `detailBullets`, table specs, UPCItemDB API |
| **ASIN** | Regex path `/(dp\|gp)/[A-Z0-9]{10}` | ScraperAPI structured ASIN | HTML hidden inputs `<input id="ASIN">` | Spec table row labeled `ASIN` |
| **Retail Price** | ScraperAPI `data.pricing` | JSON-LD `offers.price` | Amazon `.priceToPay` / Buybox IDs | Walmart `itemprop="price"`, meta tags |
| **Image** | ScraperAPI `main_image` | `landingImage` (JSON dynamic map) | Walmart hero image / `__NEXT_DATA__` | `og:image`, `twitter:image` |
| **Brand** | ScraperAPI `brand_name` | Amazon `#bylineInfo` | JSON-LD `brand.name` | First word(s) of product name |

---

## ⚙️ Modes & Field Customization

Users select their active mode with the `/start` command. Each mode defines default fields, which can be modified per chat:

| Mode | Default Included Fields | Primary Intended Target |
|---|---|---|
| **📧 Mail** | `subject`, `name`, `price`, `units`, `upc`, `link`, `image` | Bulk email campaigns & newsletters |
| **💼 LinkedIn** | `upc`, `price`, `units`, `link`, `image` | Social feed B2B posts |
| **🌐 Website** | `name`, `price`, `units`, `upc`, `asin`, `link`, `image` | E-commerce catalog creation |

### Interactive Keyboard Controls:
- **Toggle Individual Field**: Click `[✅ UPC]` to switch between checked and unchecked.
- **Select / Deselect All**: Click `☑️ All` or `⬜ None` to toggle all fields at once.
- **Change Mode**: Click `↩️ Change Mode` to switch between Mail, LinkedIn, and Website.
- **Done**: Click `✔️ Done` to commit settings to Firebase Firestore.

---

## 🗄️ Database Schema (Firebase Firestore)

The application utilizes two primary collections in Google Cloud Firestore:

### 1. `userModes` Collection
Stores user configurations and active channel preferences keyed by `chatId`.
```json
// Document ID: "<chatId>" (e.g. "123456789")
{
  "mode": "mail",
  "fields": {
    "mail": ["subject", "name", "price", "units", "upc", "link", "image"],
    "linkedin": ["upc", "price", "units", "link"],
    "website": ["name", "price", "units", "upc", "asin", "link", "image"]
  },
  "pendingMode": null,
  "pendingFields": {}
}
```

### 2. `processedUpdates` Collection
Guarantees idempotency and prevents duplicate webhook deliveries during cold starts or network timeouts.
```json
// Document ID: "<update_id>" (e.g. "987654321")
{
  "ts": 1727694800000
}
```

---

## 📦 Tech Stack & Dependencies

| Category | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js (v18+) | Serverless backend execution |
| **Cloud Hosting** | Vercel Serverless | Automatic scaling, zero-maintenance webhook hosting |
| **Database** | Firebase Firestore (`firebase-admin`) | User settings, state management, idempotency dedup |
| **HTML Parser** | `cheerio` | High-speed server-side DOM traversal and JSON-LD parsing |
| **Spreadsheet** | `exceljs` | Generating styled `.xlsx` spreadsheets for inventory deals |
| **Proxy / Scraper** | ScraperAPI | Rotating proxies, Amazon structured API, CAPTCHA bypass |
| **HTTP Client** | `node-fetch`, `form-data` | API queries and multipart document uploads to Telegram |

---

## 🔑 Environment Variables

Configure the following variables in your `.env` file or Vercel Project Settings:

| Variable | Description | Example / Format |
|---|---|---|
| `BOT_TOKEN` | Telegram Bot API Token obtained from [@BotFather](https://t.me/BotFather) | `1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ` |
| `FIREBASE_PROJECT_ID` | Google Firebase Project ID | `telegram-product-bot-3bf15` |
| `FIREBASE_CLIENT_EMAIL` | Service Account email with Firestore permissions | `firebase-adminsdk-xxxxx@project.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | Service Account private RSA key (handle escaped `\n`) | `"-----BEGIN PRIVATE KEY-----\nMIIEv...=="` |
| `SCRAPER_API_KEY` | API Key from ScraperAPI for proxy rotation & Amazon API | `1a2b3c4d5e6f7g8h9i0j...` |

---

## 🚀 Setup & Deployment

### 1. Local Development Setup
```bash
# 1. Clone the repository
git clone <repo-url>
cd "Telegram bot"

# 2. Install dependencies
npm install

# 3. Create your .env file
cp .env.example .env
# Populate BOT_TOKEN, FIREBASE credentials, and SCRAPER_API_KEY
```

### 2. Local Webhook Testing with ngrok
```bash
# Run local dev server (using Vercel CLI)
npx vercel dev

# Expose port (e.g., 3000) using ngrok
ngrok http 3000

# Set Telegram Webhook to your ngrok URL
curl -F "url=https://<your-ngrok-subdomain>.ngrok-free.app/api/webhook" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

### 3. Deploy to Vercel
```bash
# Deploy to production using Vercel CLI
npx vercel --prod
```
Ensure all environment variables (`BOT_TOKEN`, `FIREBASE_*`, `SCRAPER_API_KEY`) are added in **Vercel Project Settings → Environment Variables**.

Set your production Telegram webhook:
```bash
curl -F "url=https://<your-vercel-domain>.vercel.app/api/webhook" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

---

## 📂 Project Directory Structure

```text
├── api/
│   └── webhook.js             # Core bot handler: routing, scraping, Excel generation, formatting
├── public/
│   └── index.html             # Minimal health-check status page
├── .env                       # Local environment secrets (ignored by git)
├── .gitignore                 # Git ignore file (.vercel, etc.)
├── package.json               # Node.js dependencies and project scripts
├── vercel.json                # Vercel serverless function configuration (maxDuration: 300s)
└── README.md                  # Comprehensive project documentation
```

---

## 🔧 Troubleshooting & Maintenance

### 1. Bot Sends Duplicate Messages
- **Root Cause**: Telegram webhooks timeout if response is not received within ~5 seconds, causing Telegram to re-send updates.
- **Solution**: The bot uses Firestore `processedUpdates` deduplication and issues `res.status(200).send("OK")` early before executing heavy scraping and Excel generation tasks.

### 2. Missing UPC on Amazon Products
- **Root Cause**: Amazon frequently omits UPCs from standard HTML pages for private-label or certain branded items.
- **Solution**: The scraper first checks ScraperAPI's structured database, then parses JSON-LD schemas, table details, and finally queries the `upcitemdb.com` search trial API using the clean product title.

### 3. Walmart Scraper Returning 0 Data
- **Root Cause**: Walmart aggressively triggers anti-bot checkpoints.
- **Solution**: Requests are proxied via ScraperAPI. The bot parses `__NEXT_DATA__` for complete JSON data without relying on client-side JS rendering.
#   T e l e g r a m - b o t - v e r c e l  
 