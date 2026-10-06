/**
 * Product-image normalisation.
 *
 * Every product photo that the bot sends to Telegram (all modes: Mail,
 * LinkedIn, Website) is turned into a fixed 500 x 500 px JPEG on a WHITE
 * background:
 *   - the whole product stays visible (nothing is cropped or stretched),
 *   - the picture is centred, extra space is filled with white,
 *   - transparent PNG/WebP backgrounds become white,
 *   - images smaller than 500px are NOT enlarged (that would look blurry);
 *     they are centred on the white square at their real size.
 *
 * If anything fails (download error, unsupported file, ...) the helpers fall
 * back to the original image URL so the reply is never lost.
 */

"use strict";

const fetch = require("node-fetch");
const { sendPhoto, sendPhotoBuffer } = require("./telegram");

const SIZE = 500;
const MAX_BYTES = 15 * 1024 * 1024; // refuse absurdly large downloads

/**
 * Downloads `url` and returns a 500x500 white-background JPEG Buffer,
 * or null when it can't be processed.
 */
async function squareImage(url, size = SIZE) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  try {
    const sharp = require("sharp"); // loaded lazily so a missing binary never breaks the bot

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      timeout: 10000,
      size: MAX_BYTES,
    });
    if (!res.ok) {
      console.log(`[image] download failed HTTP ${res.status}`);
      return null;
    }
    const input = await res.buffer();
    if (!input || input.length === 0) return null;

    // 1) Fit inside size x size (never enlarge), flatten transparency onto white.
    const fitted = await sharp(input, { failOn: "none" })
      .rotate() // respect EXIF orientation
      .flatten({ background: "#ffffff" })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .toBuffer();

    // 2) Centre it on a white size x size canvas.
    return await sharp({
      create: { width: size, height: size, channels: 3, background: "#ffffff" },
    })
      .composite([{ input: fitted, gravity: "center" }])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (e) {
    console.log(`[image] squareImage error: ${e.message}`);
    return null;
  }
}

/**
 * Sends a product photo as 500x500 white. `squared` may be a Buffer that was
 * prepared earlier (see squareImage); otherwise it is created here.
 * Falls back to the original URL if processing or upload fails.
 * Returns Telegram's JSON response ({ ok, ... }).
 */
async function sendSquarePhoto(chatId, imageUrl, caption, extra = {}, squared) {
  const buf = squared || (await squareImage(imageUrl));
  if (buf) {
    const r = await sendPhotoBuffer(chatId, buf, caption, extra);
    if (r && r.ok) return r;
    console.log(`[image] sendPhotoBuffer failed: ${r && r.description}`);
  }
  return sendPhoto(chatId, imageUrl, caption, extra); // original image as a fallback
}

module.exports = { squareImage, sendSquarePhoto, SIZE };
