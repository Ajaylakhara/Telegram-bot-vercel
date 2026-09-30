const ExcelJS = require("exceljs");
const { parseMultiProduct } = require("./parser");
const { scrapeProduct, sleep } = require("./scraper");
const { sendMessage, sendDocument } = require("./telegram");

/**
 * True when the message should be treated as a wholesale/inventory deal
 * instead of a normal product-scrape message:
 *   - "Retail value $X" AND "Asking price $Y", OR
 *   - 2+ product URLs AND an "Asking Price - $X" line (no retail value needed)
 */
function isInventoryMessage(text) {
  const hasRetail = /retail\s+value\s+\$[\d,]+(\.[\d]+)?/i.test(text);
  const hasAsking = /asking\s+price\s*[-\u2013:]?\s*\$?\s*[\d,]+(\.[\d]+)?/i.test(text);
  const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
  return (hasRetail && hasAsking) || (urlCount >= 2 && hasAsking);
}

/** Extracts the stated "Retail value $X" and "Asking price $Y" figures. */
function parseInventoryPrices(text) {
  const retailMatch = text.match(/retail\s+value\s+\$([\d,]+(\.[\d]+)?)/i);
  const askingMatch = text.match(/asking\s+price\s*[-\u2013:]?\s*\$?\s*([\d,]+(\.[\d]+)?)/i);
  const retailValue = retailMatch ? parseFloat(retailMatch[1].replace(/,/g, "")) : 0;
  const askingPrice = askingMatch ? parseFloat(askingMatch[1].replace(/,/g, "")) : 0;
  return { retailValue, askingPrice };
}

/**
 * Builds the styled .xlsx workbook buffer for an inventory deal.
 * Columns: Product Name | Retail Price | Unit | UPC Code | ASIN Code | Product Link | Total Price
 */
async function buildInventoryExcel(rows, askingPrice) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");

  ws.columns = [
    { key: "name", width: 50 },
    { key: "price", width: 14 },
    { key: "units", width: 10 },
    { key: "upc", width: 18 },
    { key: "asin", width: 14 },
    { key: "link", width: 38 },
    { key: "total", width: 16 },
  ];

  ws.addRow([]); // Row 1: blank spacer

  const headerBorder = {
    top: { style: "thin" }, left: { style: "thin" },
    bottom: { style: "thin" }, right: { style: "thin" },
  };

  const headerRow = ws.addRow([
    "Product Name", "Retail Price", "Unit", "UPC Code", "ASIN Code", "Product Link", "Total Price",
  ]);
  headerRow.height = 18;
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.border = headerBorder;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
  });

  let totalUnits = 0;
  let totalCalcRetail = 0;

  for (const row of rows) {
    const dataRow = ws.addRow([
      row.name || "N/A",
      row.retailPrice != null ? row.retailPrice : "",
      row.units != null ? Number(row.units) : "",
      row.upc || "",
      row.asin || "",
      "",
      row.extendedValue != null ? row.extendedValue : "",
    ]);

    const isEven = dataRow.number % 2 === 0;
    const rowFill = isEven
      ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } }
      : { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
    dataRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = rowFill;
      cell.border = headerBorder;
    });

    dataRow.getCell(2).numFmt = "$#,##0.00";
    dataRow.getCell(3).numFmt = "#,##0";
    dataRow.getCell(7).numFmt = "$#,##0.00";

    if (row.url) {
      const linkCell = dataRow.getCell(6);
      linkCell.value = { text: row.url, hyperlink: row.url };
      linkCell.font = { color: { argb: "FF0000FF" }, underline: true };
    }

    if (row.units) totalUnits += Number(row.units);
    if (row.extendedValue) totalCalcRetail += row.extendedValue;
  }

  ws.addRow([]); ws.addRow([]); ws.addRow([]); // 3 blank rows before TOTAL

  const totalRow = ws.addRow(["TOTAL", "", totalUnits, "", "", "", totalCalcRetail]);
  totalRow.font = { bold: true };
  totalRow.getCell(3).numFmt = "#,##0";
  totalRow.getCell(7).numFmt = "$#,##0.00";
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE599" } };
    cell.border = headerBorder;
  });

  ws.addRow([]); // 1 blank row

  const askRow = ws.addRow(["Asking Price =", "", "", "", "", "", askingPrice]);
  askRow.getCell(1).font = { bold: true };
  askRow.getCell(7).numFmt = "$#,##0.00";
  askRow.getCell(7).font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, totalUnits, totalCalcRetail };
}

/**
 * Full handler for a detected wholesale/inventory message.
 * Scrapes every product, estimates missing prices from the stated retail
 * value, builds the Excel workbook, and sends it plus a summary message.
 */
async function handleInventoryMessage(chatId, message) {
  console.log(`[inventory] Detected wholesale message for chat ${chatId}`);

  const parsed = parseMultiProduct(message);
  if (parsed.length === 0) {
    await sendMessage(chatId, "⚠️ Inventory mode: no product URLs detected.");
    return;
  }

  const { retailValue, askingPrice } = parseInventoryPrices(message);

  await sendMessage(chatId, `🔍 Processing ${parsed.length} product(s) for inventory deal… please wait.`);

  // First pass: scrape all products in parallel
  const scrapedResults = await Promise.all(
    parsed.map((p) => scrapeProduct(p.url).then((info) => ({ ...p, ...info })))
  );

  // Retry pass: re-scrape any product that came back with no data, so a
  // single blocked request doesn't leave a permanent gap in the sheet.
  const INVENTORY_MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= INVENTORY_MAX_RETRIES; attempt++) {
    const failedIndices = scrapedResults
      .map((r, i) => (!r.name || r.name === "" ? i : -1))
      .filter((i) => i >= 0);
    if (failedIndices.length === 0) break;

    console.log(`[inventory] Retry ${attempt}/${INVENTORY_MAX_RETRIES}: re-scraping ${failedIndices.length} product(s) with no data...`);
    await sleep(500);

    for (const idx of failedIndices) {
      const retryInfo = await scrapeProduct(scrapedResults[idx].url);
      if (retryInfo.name) scrapedResults[idx].name = retryInfo.name;
      if (retryInfo.brand) scrapedResults[idx].brand = retryInfo.brand;
      if (retryInfo.image) scrapedResults[idx].image = retryInfo.image;
      if (retryInfo.upc) scrapedResults[idx].upc = retryInfo.upc;
      if (retryInfo.asin) scrapedResults[idx].asin = retryInfo.asin;
      if (retryInfo.scrapedPrice !== null) scrapedResults[idx].scrapedPrice = retryInfo.scrapedPrice;
      if (failedIndices.length > 1) await sleep(500);
    }
  }

  // Build row data with extended values
  const rows = scrapedResults.map((p) => {
    const unitCount = p.units ? Number(p.units) : null;
    const retailPrice = p.scrapedPrice;
    const extendedValue = (unitCount != null && retailPrice != null)
      ? +(unitCount * retailPrice).toFixed(2)
      : null;
    return {
      name: p.name || "N/A",
      retailPrice,
      units: unitCount,
      upc: p.upc || "",
      asin: p.asin || "",
      url: p.url,
      extendedValue,
    };
  });

  // Estimate any still-missing prices proportionally from the stated retail value
  const missingPriceRows = rows.filter((r) => r.retailPrice === null && r.units != null);
  if (missingPriceRows.length > 0 && retailValue > 0) {
    const knownTotal = rows.filter((r) => r.extendedValue != null).reduce((sum, r) => sum + r.extendedValue, 0);
    const remainingRetail = retailValue - knownTotal;
    const remainingUnits = missingPriceRows.reduce((sum, r) => sum + (r.units || 0), 0);

    if (remainingRetail > 0 && remainingUnits > 0) {
      for (const row of missingPriceRows) {
        const estimatedPrice = +(remainingRetail / remainingUnits).toFixed(2);
        row.retailPrice = estimatedPrice;
        row.extendedValue = +(row.units * estimatedPrice).toFixed(2);
        console.log(`[inventory] Estimated price for "${row.name}": $${estimatedPrice}/unit (from stated retail value)`);
      }
    }
  }

  let buffer, totalUnits, totalCalcRetail;
  try {
    ({ buffer, totalUnits, totalCalcRetail } = await buildInventoryExcel(rows, askingPrice));
  } catch (xlErr) {
    console.error("[inventory] Excel generation failed:", xlErr);
    await sendMessage(chatId, "❌ Failed to generate Excel file. Please try again.");
    return;
  }

  const docResult = await sendDocument(
    chatId,
    buffer,
    "inventory_deal.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  if (!docResult.ok) console.error("[inventory] sendDocument failed:", docResult.description);

  const discount = (retailValue > 0 && askingPrice > 0)
    ? ((1 - askingPrice / retailValue) * 100).toFixed(1)
    : null;
  const calcVsStated = retailValue > 0
    ? `\n📊 Stated Retail: $${retailValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  const discountLine = discount !== null ? `\n💸 Discount: ${discount}% off stated retail` : "";

  const summary =
    `📦 *Inventory Deal Summary*\n` +
    `─────────────────────────\n` +
    `🔢 Total Units: ${totalUnits.toLocaleString("en-US")}\n` +
    `💰 Calculated Retail Value: $${totalCalcRetail.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` +
    calcVsStated +
    `\n🏷️ Asking Price: $${askingPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` +
    discountLine;

  await sendMessage(chatId, summary, { parse_mode: "Markdown" });
}

module.exports = { isInventoryMessage, parseInventoryPrices, buildInventoryExcel, handleInventoryMessage };