const fetch = require("node-fetch");
const cheerio = require("cheerio");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node-fetch error messages contain the full request URL; never log the API key.
const redactKey = (msg) => String(msg || "").replace(/api_key=[^&\s"')]+/gi, "api_key=***");

// ---------- Browser fingerprint rotation (reduces bot detection) ----------
const USER_AGENTS = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ch: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    ch: '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ch: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    platform: '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    ch: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    platform: '"Linux"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    ch: null, // Firefox does not send sec-ch-ua
    platform: null,
  },
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.8",
  "en-GB,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.7",
];

function getBrowserHeaders(referer = "https://www.google.com/") {
  const profile = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const lang = ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)];
  const isFirefox = profile.ua.includes("Firefox");

  const headers = {
    "User-Agent": profile.ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": lang,
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    "DNT": "1",
    "Referer": referer,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "cross-site",
    "sec-fetch-user": "?1",
  };

  if (!isFirefox && profile.ch) {
    headers["sec-ch-ua"] = profile.ch;
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = profile.platform;
  }

  return headers;
}

// ---------- Name validation ----------
// Rejects names that are clearly garbage: UI artifacts, site names, or too long
function isValidName(name) {
  if (!name || name.length < 8 || name.length > 200) return false;
  const lower = name.toLowerCase();
  const junkKeywords = [
    "modal", "close button", "modalclose", "open prime", "buttonopen",
    "overlay", "dialog", "signin", "sign in",
    "amazon.com", "walmart.com", "shop amazon", "shop walmart",
    "online shopping", "free delivery",
  ];
  return !junkKeywords.some((kw) => lower.includes(kw));
}

function pickName(...candidates) {
  for (const n of candidates) {
    const s = (n || "").trim();
    if (isValidName(s)) return s;
  }
  return "";
}

// ---------- ASIN / short-URL helpers ----------
function extractAsin(url) {
  if (!url) return null;
  const m =
    url.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[\/?#]|$)/i) ||
    url.match(/a\.co\/d\/([A-Z0-9]{10})(?:[\/?#]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

// Rapid direct resolution of shortlinks (a.co, amzn.to)
async function resolveShortUrl(url) {
  try {
    if (/a\.co\/|amzn\.to\//i.test(url)) {
      let res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      let location = res.headers.get("location");
      if (!location && res.status === 404 && /a\.co\/d\/[dD]/i.test(url)) {
        // Handle common OCR / font typo where 0 was typed as D
        const altUrl = url.replace(/a\.co\/d\/[dD]/i, "a.co/d/0");
        const altRes = await fetch(altUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        });
        location = altRes.headers.get("location");
        if (location) console.log(`[resolve] Fixed typo: ${url} → ${altUrl}`);
      }
      if (location) {
        console.log(`[resolve] Short URL resolved: ${url} → ${location}`);
        return location;
      }
    }
  } catch (err) {
    console.log(`[resolve] Short URL resolution error: ${err.message}`);
  }
  return url;
}

// ---------- ScraperAPI Structured Amazon Product API ----------
// Zero CAPTCHAs, returns clean JSON directly.
async function scrapeAmazonStructured(asin) {
  const apiKey = (process.env.SCRAPER_API_KEY || "").trim();
  if (!apiKey || !asin) return null;
  try {
    const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${apiKey}&asin=${asin}&country_code=us`;
    console.log(`[scrape] Fetching structured Amazon data for ASIN: ${asin}`);
    const res = await fetch(url, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
    if (!res.ok) {
      console.log(`[scrape] Structured Amazon API HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data && data.name) {
      let image = data.main_image || "";
      if (!image && Array.isArray(data.images) && data.images.length > 0) {
        const first = data.images[0];
        image = typeof first === "string" ? first : (first?.images?.[0] || first?.url || "");
      }

      let upc = "";
      // ScraperAPI returns UPC under many different field names depending on product
      const rawUpc =
        data.upc ||
        data.product_information?.upc ||
        data.product_information?.global_trade_identification_number ||
        data.product_information?.gtin ||
        data.product_information?.ean ||
        data.specifications?.find?.((s) => /^upc$/i.test(s?.name))?.value ||
        data.product_details?.upc ||
        data.product_details?.gtin ||
        data.technicalDetails?.upc ||
        "";
      if (rawUpc) {
        const m = String(rawUpc).match(/\d{10,14}/);
        upc = m ? m[0] : String(rawUpc).trim();
      }

      let brand =
        data.product_information?.brand_name ||
        data.brand_name ||
        data.brand ||
        "";
      if (typeof brand === "string") {
        brand = brand
          .replace(/^Visit the /i, "")
          .replace(/ Store$/i, "")
          .replace(/^Brand\s*:\s*/i, "")
          .trim();
      }

      let scrapedPrice = null;
      if (data.pricing) {
        const p = parseFloat(String(data.pricing).replace(/[^0-9.]/g, ""));
        if (!isNaN(p) && p > 0 && p <= 5000) scrapedPrice = p;
      }

      return { name: data.name.trim(), brand, image, upc, asin, scrapedPrice };
    }
  } catch (e) {
    console.log(`[scrape] Structured Amazon API error: ${redactKey(e.message)}`);
  }
  return null;
}

// ---------- UPC lookup by name (last-resort fallback) ----------
async function lookupUpcByName(name) {
  if (!name || name.length < 5) return "";
  try {
    const q = name.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const res = await fetch(
      `https://api.upcitemdb.com/prod/trial/search?s=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined }
    );
    if (res.ok) {
      const data = await res.json();
      if (data && data.items && data.items.length > 0 && data.items[0].upc) {
        return data.items[0].upc;
      }
    }
  } catch (_) { }
  return "";
}

// ---------- Main scraper ----------
/**
 * Scrapes a single product URL (Amazon or Walmart) and returns:
 * { name, brand, image, upc, asin, scrapedPrice, error }
 */
async function scrapeProduct(url, retryCount = 0) {
  const result = { name: "", brand: "", image: "", upc: "", asin: "", scrapedPrice: null, error: null };
  const MAX_RETRIES = 2;
  try {
    // 1. Resolve short URLs (a.co, amzn.to)
    let normalizedUrl = url;
    if (/a\.co\/|amzn\.to\//i.test(url)) {
      normalizedUrl = await resolveShortUrl(url);
    }

    // 2. Normalize bare walmart.com → www.walmart.com
    if (/^https?:\/\/walmart\.com\//i.test(normalizedUrl)) {
      normalizedUrl = normalizedUrl.replace(/^(https?:\/\/)walmart\.com\//i, "$1www.walmart.com/");
      console.log(`[scrape] Normalized Walmart URL: ${url} → ${normalizedUrl}`);
    }

    const isWalmart = normalizedUrl.includes("walmart.com");
    const isAmazon =
      normalizedUrl.includes("amazon.com") ||
      normalizedUrl.includes("a.co") ||
      url.includes("amazon.com") ||
      url.includes("a.co");

    // 3. Early ASIN extraction
    const earlyAsin = extractAsin(normalizedUrl) || extractAsin(url);
    if (earlyAsin) result.asin = earlyAsin;

    const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

    // 4. Amazon fast-path: ScraperAPI's structured Amazon Product API
    if (isAmazon && result.asin && SCRAPER_API_KEY) {
      const structured = await scrapeAmazonStructured(result.asin);
      if (structured && structured.name) {
        result.name = structured.name;
        result.brand = structured.brand;
        result.image = structured.image;
        result.upc = structured.upc;
        if (structured.scrapedPrice !== null) result.scrapedPrice = structured.scrapedPrice;

        if (!result.upc && result.name) {
          const fallbackUpc = await lookupUpcByName(result.name);
          if (fallbackUpc) result.upc = fallbackUpc;
        }

        console.log(`[scrape] Amazon structured API success: "${result.name}" (ASIN: ${result.asin})`);
        return result;
      }
    }

    // 5. HTML scraping fallback (or Walmart)
    let referer = isWalmart
      ? "https://www.google.com/search?q=walmart+product"
      : "https://www.google.com/";
    if (!isWalmart) {
      try { referer = new URL(normalizedUrl).origin + "/"; } catch (_) { }
    }

    let headers;
    if (isWalmart && retryCount === 1) {
      headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "From": "googlebot(at)googlebot.com",
        "Connection": "keep-alive",
      };
      console.log(`[scrape] Walmart retry ${retryCount}: switching to Googlebot UA`);
    } else if (isWalmart && retryCount >= 2) {
      headers = {
        "User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      };
      console.log(`[scrape] Walmart retry ${retryCount}: switching to Bingbot UA`);
    } else {
      headers = getBrowserHeaders(referer);
    }

    const fetchUrl = normalizedUrl;
    let pageRes, resolvedUrl, html;

    if (SCRAPER_API_KEY) {
      const scraperUrl =
        `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}` +
        `&url=${encodeURIComponent(fetchUrl)}`;
      console.log(`[scrape] Using ScraperAPI for: ${fetchUrl}`);
      pageRes = await fetch(scraperUrl, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
      });
      resolvedUrl = fetchUrl;
      html = await pageRes.text();
    } else {
      console.log(`[scrape] Direct fetch (no ScraperAPI key): ${fetchUrl}`);
      pageRes = await fetch(fetchUrl, {
        headers,
        signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      resolvedUrl = pageRes.url || fetchUrl;
      if (resolvedUrl !== fetchUrl) console.log(`[scrape] Redirect: ${fetchUrl} → ${resolvedUrl}`);
      html = await pageRes.text();
    }

    const $ = cheerio.load(html);
    const pageTitle = $("title").text().trim();
    console.log(`[scrape] HTTP ${pageRes.status} | len: ${html.length} | title: "${pageTitle}"`);

    const pageTitleLower = pageTitle.toLowerCase();
    const isBlocked =
      (isWalmart ? html.length < 1000 : html.length < 5000) ||
      pageTitleLower.includes("robot") ||
      pageTitleLower.includes("captcha") ||
      pageTitleLower.includes("verify your identity") ||
      pageTitleLower.includes("security block") ||
      pageTitleLower.includes("sorry, we just need") ||
      pageTitleLower.includes("robot check") ||
      pageTitleLower.includes("access denied") ||
      pageRes.status === 503 ||
      pageRes.status === 429 ||
      pageRes.status === 403;

    if (isBlocked) {
      if (SCRAPER_API_KEY && retryCount < MAX_RETRIES) {
        console.log(`[scrape] Blocked on attempt ${retryCount + 1}/${MAX_RETRIES + 1} (${pageTitle}), retrying via ScraperAPI...`);
        await sleep(1000);
        return scrapeProduct(url, retryCount + 1);
      }
      // Last-resort fallback for Amazon URL slug if name still empty
      if (isAmazon && !result.name) {
        const slugMatch = normalizedUrl.match(/amazon\.com\/([^\/]+)\/dp\//i);
        if (slugMatch && slugMatch[1] && !slugMatch[1].startsWith("dp")) {
          result.name = decodeURIComponent(slugMatch[1]).replace(/[-_]+/g, " ");
        }
      }
      return result;
    }

    // --- JSON-LD extraction: two-pass strategy ---
    const extractFromBlock = (data) => {
      if (data.name && !result.name) result.name = data.name;
      if (data.image && !result.image) {
        const imgData = Array.isArray(data.image) ? data.image[0] : data.image;
        result.image = (typeof imgData === "object" && imgData.url)
          ? imgData.url
          : (typeof imgData === "string" ? imgData : "");
      }
      if (!result.upc) {
        if (data.gtin13) result.upc = data.gtin13;
        else if (data.gtin) result.upc = data.gtin;
        else if (data.sku && isWalmart) result.upc = data.sku;
      }
      if (!result.brand && data.brand) {
        const b = data.brand;
        result.brand = (typeof b === "object" ? (b.name || "") : String(b)).trim();
      }
      if (result.scrapedPrice === null && data.offers) {
        const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
        const rawPrice = offers?.price ?? offers?.lowPrice ?? null;
        if (rawPrice !== null && rawPrice !== undefined) {
          const parsed = parseFloat(String(rawPrice).replace(/,/g, ""));
          if (!isNaN(parsed) && parsed > 0) result.scrapedPrice = parsed;
        }
      }
    };

    const allBlocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const blocks = Array.isArray(json) ? json : [json];
        allBlocks.push(...blocks);
      } catch (e) { /* ignore malformed */ }
    });

    for (const data of allBlocks) {
      const type = (data["@type"] || "").toLowerCase();
      if (type === "product") extractFromBlock(data);
    }

    if (!result.name && !result.image && !result.upc) {
      for (const data of allBlocks) {
        const type = (data["@type"] || "").toLowerCase();
        if (type === "itemlist" || type === "breadcrumblist" || type === "website") continue;
        const hasProductFields = data.image || data.gtin13 || data.gtin || (data.sku && isWalmart);
        if (data.name && hasProductFields) {
          extractFromBlock(data);
          break;
        }
      }
    }

    // --- Walmart __NEXT_DATA__ extraction ---
    if (isWalmart) {
      try {
        const nextDataRaw = $("#__NEXT_DATA__").html();
        if (nextDataRaw) {
          const nd = JSON.parse(nextDataRaw);
          const item =
            nd?.props?.pageProps?.initialData?.data?.product?.item ||
            nd?.props?.pageProps?.initialData?.data?.idmlMap?.item ||
            nd?.props?.pageProps?.product?.item ||
            nd?.props?.pageProps?.initialData?.data?.product ||
            null;

          if (item) {
            if (!result.name) {
              result.name = (item.name || item.productName || item.shortDescription || "").trim();
            }
            if (!result.brand) {
              result.brand = (item.brand || item.brandName || item.manufacturerName || "").trim();
            }
            if (!result.image) {
              const imgs = item.imageInfo?.thumbnailUrl || item.imageInfo?.allImages?.[0]?.url || item.image || "";
              if (typeof imgs === "string" && imgs.startsWith("http")) result.image = imgs;
            }
            if (!result.upc) {
              const upcRaw = item.upc || item.barcode || item.additionalAttributes?.upc || "";
              const digitMatch = String(upcRaw).match(/\d{10,14}/);
              if (digitMatch) result.upc = digitMatch[0];
            }
            if (result.scrapedPrice === null) {
              const priceVal =
                item.priceInfo?.currentPrice?.price ??
                item.priceInfo?.currentPrice?.priceString ??
                item.priceInfo?.unitPrice?.price ??
                item.price?.currentPrice ??
                item.price?.price ??
                item.currentPrice ??
                null;
              if (priceVal !== null && priceVal !== undefined) {
                const parsed = parseFloat(String(priceVal).replace(/[^0-9.]/g, ""));
                if (!isNaN(parsed) && parsed > 0) {
                  result.scrapedPrice = parsed;
                  console.log(`[scrape] Walmart __NEXT_DATA__ price: ${parsed}`);
                }
              }
            }
          }
        }
      } catch (e) {
        console.log(`[scrape] __NEXT_DATA__ parse failed: ${e.message}`);
      }
    }

    // --- HTML fallback for NAME ---
    if (!result.name) {
      const productTitleEl = $("#productTitle");
      let cleanTitle = "";
      if (productTitleEl.length) {
        const clone = productTitleEl.clone();
        clone.find("span, button, a, i").remove();
        cleanTitle = clone.text().trim();
        if (!cleanTitle) cleanTitle = productTitleEl.contents().filter((_, n) => n.type === "text").text().trim();
      }

      result.name = pickName(
        cleanTitle,
        $("#title").clone().find("span,button").remove().end().text(),
        $("h1[itemprop='name']").text(),
        $("h1.prod-ProductTitle").text(),
        $("meta[property='og:title']").attr("content"),
        $("meta[name='twitter:title']").attr("content"),
        (() => {
          const rawTitle = $("title").text().trim();
          return rawTitle
            .replace(/^Amazon\.com\s*:\s*/i, "")
            .replace(/\s*:\s*Amazon\.com.*$/i, "")
            .replace(/\s*-\s*Walmart\.com.*$/i, "")
            .replace(/\s*\|\s*.*$/, "")
            .trim();
        })()
      );
    }

    // --- HTML fallback for UPC ---
    if (!result.upc) {
      let foundUpc = "";
      const extractUpcFromText = (text) => {
        const m = text.match(/UPC\s*:?\s*(\d{10,14})/i);
        return m ? m[1] : "";
      };

      // 1. #detailBullets_feature_div — bullet-list format (span label + span value)
      if (!foundUpc) {
        $("#detailBullets_feature_div li").each((_, el) => {
          if (foundUpc) return;
          const spans = $(el).find("span");
          spans.each((i, span) => {
            if (foundUpc) return;
            if ($(span).text().trim().toLowerCase() === "upc" && spans.eq(i + 1).length) {
              foundUpc = spans.eq(i + 1).text().trim();
            }
          });
        });
      }

      // 2. detailBullets text scan
      if (!foundUpc) {
        const containerText = $("#detailBulletsWrapper_feature_div, #detailBullets_feature_div").text();
        if (containerText) foundUpc = extractUpcFromText(containerText);
      }

      // 3. productDetails th-td tables (standard detail tables)
      if (!foundUpc) {
        $(
          "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, " +
          "#technicalSpecifications_section_1 tr, #prodDetails tr"
        ).each((_, el) => {
          if (foundUpc) return;
          const th = $(el).find("th").text().trim().toLowerCase();
          if (th === "upc" || th === "global trade identification number") {
            foundUpc = $(el).find("td").text().trim();
          }
        });
      }

      // 4. #productDetails_db_sections — the "Product specifications" popup table
      //    shown in the screenshot: td-td format (label cell | value cell)
      if (!foundUpc) {
        $("#productDetails_db_sections tr, .a-bordered tr").each((_, el) => {
          if (foundUpc) return;
          const tds = $(el).find("td");
          if (tds.length >= 2) {
            const label = tds.eq(0).text().trim().toLowerCase();
            if (label === "upc" || label === "global trade identification number") {
              foundUpc = tds.eq(1).text().trim();
              if (foundUpc) console.log(`[scrape] UPC found in product specs table: ${foundUpc}`);
            }
          }
        });
      }

      // 5. .a-expander-content — expanded specs sections (collapsible panels)
      if (!foundUpc) {
        $(".a-expander-content tr").each((_, el) => {
          if (foundUpc) return;
          const cells = $(el).find("td, th");
          if (cells.length >= 2) {
            const label = cells.eq(0).text().trim().toLowerCase();
            if (label === "upc" || label === "global trade identification number") {
              foundUpc = cells.eq(1).text().trim();
            }
          }
        });
      }

      // 6. #prodDetails full text scan
      if (!foundUpc) {
        const prodDetailsText = $("#prodDetails").text();
        if (prodDetailsText) foundUpc = extractUpcFromText(prodDetailsText);
      }

      // 7. #poExpander / .a-normal-rating-table
      if (!foundUpc) {
        $("#poExpander tr, .a-normal-rating-table tr").each((_, el) => {
          if (foundUpc) return;
          const cells = $(el).find("td, th");
          if (cells.length >= 2) {
            const label = cells.eq(0).text().trim().toLowerCase();
            if (label === "upc" || label === "global trade identification number") {
              foundUpc = cells.eq(1).text().trim();
            }
          }
        });
      }

      // 8. Generic tr sweep — any table on the page
      if (!foundUpc) {
        $("tr").each((_, el) => {
          if (foundUpc) return;
          const thText = $(el).find("th").text().trim().toLowerCase();
          const tds = $(el).find("td");
          if ((thText === "upc" || thText === "global trade identification number") && tds.length > 0) {
            foundUpc = tds.first().text().trim();
          } else if (tds.length >= 2) {
            const firstTd = tds.eq(0).text().trim().toLowerCase();
            if (firstTd === "upc" || firstTd === "global trade identification number") {
              foundUpc = tds.eq(1).text().trim();
            }
          }
        });
      }

      // 9. Inline text scan (li, span) — last resort before name lookup
      if (!foundUpc) {
        $("li, span").each((_, el) => {
          if (foundUpc) return;
          const text = $(el).text();
          if (text.length < 150) foundUpc = extractUpcFromText(text) || foundUpc;
        });
      }

      if (foundUpc) {
        const digitMatch = foundUpc.match(/\d{10,14}/);
        result.upc = digitMatch ? digitMatch[0] : foundUpc.replace(/upc/i, "").replace(":", "").trim();
      }
    }

    // --- HTML fallback for IMAGE ---
    if (!result.image) {
      const landingImg = $("#landingImage");
      if (landingImg.length) {
        const dynamicJson = landingImg.attr("data-a-dynamic-image");
        if (dynamicJson) {
          try {
            const imgMap = JSON.parse(dynamicJson);
            const best = Object.entries(imgMap).sort((a, b) => b[1][0] - a[1][0])[0];
            if (best) result.image = best[0];
          } catch (_) { }
        }
        if (!result.image) result.image = landingImg.attr("data-old-hires") || landingImg.attr("src") || "";
      }
      if (!result.image) {
        const wrapperImg = $("#imgTagWrapperId img, .imgTagWrapper img").first();
        const dynamicJson = wrapperImg.attr("data-a-dynamic-image");
        if (dynamicJson) {
          try {
            const imgMap = JSON.parse(dynamicJson);
            const best = Object.entries(imgMap).sort((a, b) => b[1][0] - a[1][0])[0];
            if (best) result.image = best[0];
          } catch (_) { }
        }
        if (!result.image) result.image = wrapperImg.attr("data-old-hires") || wrapperImg.attr("src") || "";
      }
      if (!result.image) result.image = $("img[data-testid='hero-image']").first().attr("src") || "";
      if (!result.image) result.image = $("meta[property='og:image']").attr("content") || "";
      if (!result.image) result.image = $("meta[name='twitter:image']").attr("content") || "";
      if (result.image && !result.image.startsWith("http")) result.image = "";
    }

    // --- HTML fallback for BRAND ---
    if (!result.brand) {
      const byline = $("#bylineInfo").text().trim();
      if (byline) {
        const brandLabel = byline.match(/^Brand\s*:\s*(.+)/i);
        if (brandLabel) {
          result.brand = brandLabel[1].trim();
        } else {
          const visitStore = byline.match(/Visit the (.+?) Store/i);
          if (visitStore) result.brand = visitStore[1].trim();
        }
      }
      if (!result.brand) result.brand = $("a#brand").text().trim();
      if (!result.brand) {
        result.brand =
          $('[itemprop="brand"]').attr("content") ||
          $('[itemprop="brand"]').text().trim() ||
          $("[data-testid='product-brand']").text().trim() ||
          "";
      }
    }
    if (!result.brand && result.name) {
      const words = result.name.trim().split(/\s+/);
      result.brand = words.length > 1 && words[0].length <= 3 ? `${words[0]} ${words[1]}` : words[0];
    }

    // --- ASIN extraction (Amazon only) ---
    const isAmazonUrl = resolvedUrl.includes("amazon.com") || url.includes("amazon.com") ||
      resolvedUrl.includes("a.co") || url.includes("a.co");
    if (isAmazonUrl) {
      const urlAsin = resolvedUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[\/?#]|$)/i);
      if (urlAsin) result.asin = urlAsin[1].toUpperCase();

      if (!result.asin && url.includes("a.co/")) {
        const shortAsin = url.match(/a\.co\/d\/([A-Z0-9]{10})(?:[\/?#]|$)/i);
        if (shortAsin) result.asin = shortAsin[1].toUpperCase();
      }
      if (!result.asin) {
        result.asin = $("#ASIN").val() || $("input[name='ASIN']").val() || "";
        if (result.asin) result.asin = result.asin.trim().toUpperCase();
      }
      if (!result.asin) {
        $(
          "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, " +
          "#prodDetails tr, #detailBullets_feature_div li"
        ).each((_, el) => {
          if (result.asin) return;
          const label = $(el).find("th, span").first().text().trim().toUpperCase();
          if (label === "ASIN") result.asin = $(el).find("td, span").last().text().trim().toUpperCase();
        });
      }
    }

    // --- HTML fallback for PRICE (used by inventory/wholesale mode) ---
    if (result.scrapedPrice === null) {
      const amazonPriceSelectors = [
        "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
        "#corePrice_feature_div .priceToPay .a-offscreen",
        ".priceToPay .a-offscreen",
        "#apex_desktop_newAccordionRow .priceToPay .a-offscreen",
        "#price_inside_buybox",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#newBuyBoxPrice",
        "#sns-base-price",
        "#snsPrice .a-offscreen",
        "#subscriptionPrice .a-offscreen",
        "#apex_desktop .a-price .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
        "#corePrice_feature_div .a-price .a-offscreen",
        "#buyNewSection .a-color-price",
        "#newOfferAccordionRow .a-price .a-offscreen",
        ".offer-price",
        "#olpLinkWidget_feature_div .a-color-price",
        "#rightCol .a-price .a-offscreen",
        "#buybox .a-price .a-offscreen",
        "#desktop_buybox .a-price .a-offscreen",
      ];
      for (const sel of amazonPriceSelectors) {
        const priceText = $(sel).first().text().trim();
        if (priceText) {
          const parsed = parseFloat(priceText.replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed) && parsed > 0 && parsed <= 5000) {
            result.scrapedPrice = parsed;
            console.log(`[scrape] Price from HTML (${sel}): ${parsed}`);
            break;
          }
        }
      }
    }

    if (result.scrapedPrice === null && isWalmart) {
      const walmartPriceSelectors = [
        "[itemprop='price']",
        "[data-testid='price-wrap'] .price-characteristic",
        ".price-group .price-characteristic",
        "[data-automation='buybox-price'] .price-characteristic",
      ];
      for (const sel of walmartPriceSelectors) {
        const el = $(sel).first();
        const content = el.attr("content") || el.text().trim();
        if (content) {
          const parsed = parseFloat(String(content).replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed) && parsed > 0) {
            result.scrapedPrice = parsed;
            console.log(`[scrape] Walmart price from HTML (${sel}): ${parsed}`);
            break;
          }
        }
      }
    }

    if (result.scrapedPrice === null) {
      const metaSelectors = [
        "meta[property='product:price:amount']",
        "meta[property='og:price:amount']",
        "meta[name='price']",
        "meta[name='twitter:data1']",
      ];
      for (const sel of metaSelectors) {
        const content = $(sel).attr("content") || "";
        if (content) {
          const parsed = parseFloat(content.replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed) && parsed > 0 && parsed <= 5000) {
            result.scrapedPrice = parsed;
            console.log(`[scrape] Price from meta tag (${sel}): ${parsed}`);
            break;
          }
        }
      }
    }

    if (result.scrapedPrice === null) {
      const priceSections = [
        "#buyBoxInner", "#desktop_buybox", "#price", "#newBuyBoxPrice",
        "#apex_desktop", "#corePrice_feature_div", "#corePriceDisplay_desktop_feature_div",
        "#ppd", "#rightCol",
      ];
      for (const sel of priceSections) {
        const sectionText = $(sel).text();
        if (!sectionText) continue;
        const priceMatches = sectionText.match(/\$\s*([\d,]+\.\d{2})/);
        if (priceMatches) {
          const parsed = parseFloat(priceMatches[1].replace(/,/g, ""));
          if (!isNaN(parsed) && parsed > 0 && parsed <= 5000) {
            result.scrapedPrice = parsed;
            console.log(`[scrape] Price from regex scan (${sel}): ${parsed}`);
            break;
          }
        }
      }
    }

    // Fallback UPC lookup by name if still missing from HTML
    if (!result.upc && result.name) {
      const fallbackUpc = await lookupUpcByName(result.name);
      if (fallbackUpc) result.upc = fallbackUpc;
    }

    // Page loaded fine but nothing found at all — retry before giving up
    if (!result.name && !result.upc && !result.image) {
      if (retryCount < MAX_RETRIES) {
        const delay = 1000;
        console.log(`[scrape] No data on attempt ${retryCount + 1}, retrying after ${delay}ms...`);
        await sleep(delay);
        return scrapeProduct(url, retryCount + 1);
      }
      console.log(`[scrape] No data extracted after ${retryCount + 1} attempt(s) for: ${resolvedUrl}`);
    }
  } catch (e) {
    console.error(`Scrape failed for ${url}:`, redactKey(e.message));
  }
  return result;
}

module.exports = { scrapeProduct, sleep };