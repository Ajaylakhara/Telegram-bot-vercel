# 🛠️ Bug Fix Plan: Website Mode Product Image Delivery Issue

> **Document Version**: 2.0.0 (Updated Analysis & Hardened Plan)  
> **Target Issue**: In **Website mode** with all fields enabled (including Image), sending product links results in product data (text) being delivered, but **no product image** is sent.  
> **Target Platform**: Node.js Serverless (Vercel Functions) + Telegram Bot API + Firebase Firestore + Sharp  

---

## 📌 1. Updated Root Cause Summary

When Telegram rejects a photo send in `sendProductReply` ([api/webhook.js:58-63](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L58-L63)), line 63 silently falls back to `sendMessage(chatId, caption)`, sending the text alone while swallowing the photo failure. 

While Telegram's **1,024-character caption limit** explains failures on products with lengthy titles or tracking URLs, a realistic Website caption (~350–850 characters) often fits within 1,024 characters. Therefore, caption length alone **cannot be confirmed as the sole root cause** for every product without log verification; other contributing causes include unhandled media upload failures in `sendPhotoBuffer`, image URL resolution issues, or unescaped characters if formatting changes. 

The fix must verify the exact error in Vercel logs first (Step 0) and implement resilient multi-stage fallback logic (Step 1) that retries sending the photo alone before ever abandoning image delivery.

---

## 🔬 2. Pipeline Trace & Caption Length Realities

### Realistic Caption Length Breakdown for Website Mode
Website mode formats 8 distinct components in [routing/lib/format.js:83-95](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/format.js#L83-L95):
```
Name: <name>
Price: <price>
Units: <units>
Exp: <exp>
FOB: <fob>
UPC: <upc>
ASIN: <asin>
Link: <url>
```

- **Fixed boilerplate / labels**: ~80–100 characters.
- **Scenario A (Typical Amazon Listing)**:
  - Title: ~100–180 chars
  - URL (standard or cleaned): ~50–120 chars
  - Total Caption Length: **~250–400 characters** *(well within the 1,024-char limit)*.
- **Scenario B (Keyword-Stuffed Title + Long Referral/Affiliate URL)**:
  - Title: ~250–400 chars
  - Raw Search/Affiliate URL: ~350–550 chars
  - Total Caption Length: **~700–1,050+ characters** *(at or exceeding the 1,024-char limit)*.

**Conclusion**: The 1,024-character limit causes photo rejection on long-titled items or long URLs, but cannot explain failures on products with concise titles. Hence, it is **one confirmed trigger**, but not the only one.

---

## 🔍 3. Hypotheses Verification Evidence

| # | Hypothesis | Status | File & Line | Evidence & Code Quote |
|:---|:---|:---:|:---|:---|
| **1** | Website mode has no default field list, or `userModes.fields` has no `website` key. | **RULED OUT** | [routing/lib/format.js:5](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/format.js#L5), [api/webhook.js:228](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L228) | `MODE_FIELDS.website` is defined: `["name", "price", "units", "upc", "asin", "link", "image"]`. In `api/webhook.js:228`: `const savedFields = modeDoc.exists ? (modeDoc.data().fields \|\| {})[mode] \|\| MODE_FIELDS[mode] : null;`. If the doc lacks the `website` key, it falls back to `MODE_FIELDS.website`. |
| **2** | The image field key is inconsistent across files ("image" vs "photo" vs "Image"). | **RULED OUT** | [routing/lib/format.js:5,16](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/format.js#L5), [api/webhook.js:18,34](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L18) | All files uniformly use the lowercase string `"image"`: `fieldSet.has("image")`, `fields.filter((f) => f !== "image")`, and `MODE_FIELDS.website.includes("image")`. |
| **3** | The Website caption exceeds Telegram's 1024-character limit, so sendPhoto fails and falls back to text only. | **CONFIRMED**<br>*(One confirmed cause for long items)* | [api/webhook.js:38-63](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L38-L63), [routing/lib/format.js:83-95](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/format.js#L83-L95) | When `caption.length > 1024`, Telegram strictly rejects `sendPhoto` with `400 Bad Request: MEDIA_CAPTION_TOO_LONG`. Line 63 falls back to `sendMessage` (which supports 4,096 chars), dropping the image. |
| **4** | The Website branch in webhook.js or format.js only calls sendMessage and never sendPhoto. | **RULED OUT** | [api/webhook.js:260-270](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L260-L270) | Both `linkedin` and `website` modes share the exact same loop in `api/webhook.js:267-270`, calling `sendProductReply` which invokes `sendSquarePhoto`. There is no separate branch excluding `website`. |
| **5** | The scraper returns an empty image URL for Website mode, or image.js (Sharp) throws and the fallback returns nothing. | **RULED OUT** | [routing/lib/scraper.js:274](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/scraper.js#L274), [routing/lib/image.js:76-85](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/image.js#L76-L85) | `scrapeProduct(url)` has no parameter for `mode` and runs identically. In `image.js:83`, if `buf` is null, it falls back to `sendPhoto(chatId, imageUrl, caption, extra)` using the raw URL. |
| **6** | sendPhoto errors are swallowed (empty catch) so the failure is invisible. | **CONFIRMED**<br>*(Contributing factor)* | [routing/lib/telegram.js:33-36,59-62](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/telegram.js#L33-L36), [api/webhook.js:61](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L61) | The code uses minimal `console.log` without error codes, caption length, or payload diagnostics. When `photoJson.ok` is false, it silently executes `sendMessage` without warning that the photo was dropped. |
| **7** | **NEW: `parse_mode` or unescaped text (`&`, `<`, `>`, `_`, `*`, backticks)** | **RULED OUT**<br>*(for default path)* | [routing/lib/telegram.js:24-32,49-51](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/telegram.js#L24-L32), [api/webhook.js:59](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js#L59) | In `api/webhook.js:59`, `extra` is passed as `{}`. Neither `sendPhoto` nor `sendPhotoBuffer` sets a default `parse_mode`. Telegram treats captions without `parse_mode` as plain text, meaning special characters do not cause entity parse errors. However, if `parse_mode` were ever passed, unescaped characters would break it. |

---

## 🛠️ 4. Actionable Fix Plan

### Step 0: Confirm the Cause from Vercel Logs (Before Editing Code)

1. Navigate to **Vercel Dashboard $\rightarrow$ Your Project $\rightarrow$ Logs**.
2. In Telegram, switch to **Website mode** (`/start` $\rightarrow$ `🌐 Website` $\rightarrow$ `✔️ Done`).
3. Send a single Amazon or Walmart product link.
4. Filter Vercel logs for: `[send] sendPhoto` or `[image] sendPhotoBuffer`.
5. Check against the diagnostic table below:

| Logged Message | Immediate Cause | Solution / Fix |
|:---|:---|:---|
| `Bad Request: MEDIA_CAPTION_TOO_LONG` or `caption is too long` | Caption exceeded 1,024 characters. | Handled by Step 1: Send photo alone, then text separately. |
| `Bad Request: can't parse entities` | Unescaped character parsed as markdown/HTML. | Handled by Step 1: Retries photo alone without caption. |
| `wrong file identifier` or `failed to get HTTP URL content` | Telegram could not fetch image from raw URL or buffer was rejected. | Sharp image buffer / scraper image URL fallback in Step 1. |
| `[send] sendPhotoBuffer error: ...` | Multipart upload network timeout or Sharp buffer failure. | Falls back to raw URL and retries in Step 1. |

---

### Step 1: Resilient Multi-Stage Photo Dispatch in `api/webhook.js`

**Logic Flow**:
1. If `caption.length <= 1024`: Attempt to send photo with caption together.
2. If `caption.length > 1024`: Send photo alone (no caption), then send caption via `sendMessage`.
3. If photo-with-caption fails for **any reason** (length, entity error, etc.): Retry sending the photo **alone** without a caption, and if that succeeds, send the caption via `sendMessage`.
4. Only if both photo attempts fail (e.g. invalid image URL, network drop): Fall back to `sendMessage(chatId, caption)` text-only.
5. Log every failure with `console.error` detailing the error description, caption length, image URL, and upload path.

#### Proposed Diff for `api/webhook.js`:
```diff
--- a/api/webhook.js
+++ b/api/webhook.js
@@ -31,35 +31,65 @@
  */
 async function sendProductReply(chatId, mode, product, fields) {
   const fieldSet = new Set(fields);
   const wantImage = fieldSet.has("image");
   const hasImage = wantImage && product.image && typeof product.image === "string" && product.image.startsWith("http");
   const textFields = fields.filter((f) => f !== "image");
   const onlyImage = wantImage && textFields.length === 0;
   const caption = onlyImage ? "" : formatCaption(mode, product, fields);
 
   // Only "Image" selected
   if (onlyImage) {
     if (hasImage) {
       const pj = await sendSquarePhoto(chatId, product.image, undefined, {}, product._sq);
       if (pj.ok) return;
-      console.log(`[send] sendPhoto (image-only) failed: ${pj.description}`);
+      console.error(`[send] sendPhoto (image-only) failed: ${pj.description || "unknown error"} | url: ${product.image} | path: ${product._sq ? "buffer" : "url"}`);
     }
     return; // nothing to send if image wanted but unavailable, and no text fields
   }
 
   // Image not selected at all — always plain text
   if (!wantImage) {
     await sendMessage(chatId, caption);
     return;
   }
 
-  // Image selected + text fields present — try photo+caption, fall back to text
+  // Image selected + text fields present
   let sent = false;
   if (hasImage) {
-    const photoJson = await sendSquarePhoto(chatId, product.image, caption, {}, product._sq);
-    if (photoJson.ok) sent = true;
-    else console.log(`[send] sendPhoto failed: ${photoJson.description}`);
+    const pathType = product._sq ? "sendPhotoBuffer" : "sendPhoto";
+    if (caption.length <= 1024) {
+      // 1. Try sending photo with caption together
+      const photoJson = await sendSquarePhoto(chatId, product.image, caption, {}, product._sq);
+      if (photoJson && photoJson.ok) {
+        sent = true;
+      } else {
+        console.error(`[send] Photo-with-caption failed: ${photoJson?.description || "unknown"} | len: ${caption.length} | url: ${product.image} | path: ${pathType}`);
+        // 2. Retry photo ALONE without caption, then send text
+        const retryJson = await sendSquarePhoto(chatId, product.image, undefined, {}, product._sq);
+        if (retryJson && retryJson.ok) {
+          sent = true;
+          await sendMessage(chatId, caption);
+        } else {
+          console.error(`[send] Photo-alone retry failed: ${retryJson?.description || "unknown"} | url: ${product.image} | path: ${pathType}`);
+        }
+      }
+    } else {
+      // Caption exceeds 1024 chars: send photo alone first, then text message
+      console.log(`[send] Caption length (${caption.length}) exceeds 1024 limit. Sending photo alone, then text.`);
+      const photoJson = await sendSquarePhoto(chatId, product.image, undefined, {}, product._sq);
+      if (photoJson && photoJson.ok) {
+        sent = true;
+        await sendMessage(chatId, caption);
+      } else {
+        console.error(`[send] Photo-alone (split-mode) failed: ${photoJson?.description || "unknown"} | url: ${product.image} | path: ${pathType}`);
+      }
+    }
   }
+  // Fallback: If photo send failed completely or no image available
   if (!sent) await sendMessage(chatId, caption);
 }
```

---

### Step 2: Accurate Error Logging in `routing/lib/telegram.js`

**Objective**: Ensure `sendPhoto` and `sendPhotoBuffer` log API error details (`error_code`, `description`) and return them on the JSON object instead of swallowing error messages.

#### Proposed Diff for `routing/lib/telegram.js`:
```diff
--- a/routing/lib/telegram.js
+++ b/routing/lib/telegram.js
@@ -31,8 +31,12 @@ async function sendPhoto(chatId, photo, caption, extra = {}) {
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify(payload),
     });
-    return await res.json();
+    const json = await res.json();
+    if (!json.ok) {
+      console.error(`[telegram] sendPhoto API error ${json.error_code}: ${json.description}`);
+    }
+    return json;
   } catch (e) {
-    console.log(`[send] sendPhoto error: ${e.message}`);
-    return { ok: false };
+    console.error(`[send] sendPhoto network exception: ${e.message}`);
+    return { ok: false, description: e.message };
   }
 }
@@ -57,8 +61,12 @@ async function sendPhotoBuffer(chatId, buffer, caption, extra = {}) {
       body: form,
       headers: form.getHeaders(),
     });
-    return await res.json();
+    const json = await res.json();
+    if (!json.ok) {
+      console.error(`[telegram] sendPhotoBuffer API error ${json.error_code}: ${json.description}`);
+    }
+    return json;
   } catch (e) {
-    console.log(`[send] sendPhotoBuffer error: ${e.message}`);
-    return { ok: false };
+    console.error(`[send] sendPhotoBuffer network exception: ${e.message}`);
+    return { ok: false, description: e.message };
   }
 }
```

#### Full Function Bodies for Verification:
```javascript
/** Send a photo. Pass no `caption` to send the photo with no caption at all. `extra` can include parse_mode, etc. */
async function sendPhoto(chatId, photo, caption, extra = {}) {
  const payload = { chat_id: chatId, photo, ...extra };
  if (caption !== undefined) payload.caption = caption;
  try {
    const res = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[telegram] sendPhoto API error ${json.error_code}: ${json.description}`);
    }
    return json;
  } catch (e) {
    console.error(`[send] sendPhoto network exception: ${e.message}`);
    return { ok: false, description: e.message };
  }
}

/**
 * Send a photo from raw bytes (multipart upload). Used for the processed
 * 500x500 white-background product images. `extra` can include parse_mode, etc.
 */
async function sendPhotoBuffer(chatId, buffer, caption, extra = {}) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", buffer, { filename: "product.jpg", contentType: "image/jpeg" });
  if (caption !== undefined && caption !== "") form.append("caption", caption);
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  try {
    const res = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[telegram] sendPhotoBuffer API error ${json.error_code}: ${json.description}`);
    }
    return json;
  } catch (e) {
    console.error(`[send] sendPhotoBuffer network exception: ${e.message}`);
    return { ok: false, description: e.message };
  }
}
```

---

## ⚙️ 5. Optional / Separate Change: Legacy Firestore Guard

### Background & Behavior Change:
In JavaScript, an empty array `[]` is truthy (`Boolean([]) === true`). If a user has a Firestore record where `fields.website` is stored as an empty array `[]`, the current fallback logic:
```javascript
const savedFields = modeDoc.exists ? (modeDoc.data().fields || {})[mode] || MODE_FIELDS[mode] : null;
```
keeps `savedFields` as `[]`. 

- **If we add an array-length guard**: `savedFields` will revert to `MODE_FIELDS[mode]`.
- **Tradeoff**: A user who intentionally deselected every single field (to receive no text) would have their choice overridden and receive the full default field set.
- **Recommendation**: **Do not include in this bug fix.** The user reported selecting Website mode *with all fields enabled*, so their Firestore document will not contain an empty array. Keep this change separate if needed.

---

## 🧪 6. Updated Manual Test Checklist

- [ ] **Test 1: Website Mode with Short Title (Caption $\le$ 1,024 chars)**
  - Select `🌐 Website` mode $\rightarrow$ enable all fields $\rightarrow$ send Amazon link with clean/concise title.
  - **Expected**: Single Telegram message containing 500x500 square photo with caption.
- [ ] **Test 2: Website Mode with Long Title & Long URL (Caption > 1,024 chars)**
  - Send Amazon link with lengthy title + tracking parameters.
  - **Expected**: Two sequential messages: (1) 500x500 product photo alone, followed immediately by (2) the complete product text via `sendMessage`.
- [ ] **Test 3: Product Name with Special Characters (`&`, `<`, `>`, `_`, `*`, backticks)**
  - Send an Amazon/Walmart link with titles containing symbols (e.g. `M&M's *Special Edition* _Size_ 5" <Pack>`).
  - **Expected**: Photo and caption delivered without entity parse errors.
- [ ] **Test 4: Bad Image URL / Unreachable Asset**
  - Simulate/send a link where the scraped image returns 404 or fails to load.
  - **Expected**: Photo retry logs error; cleanly falls back to text `sendMessage`.
- [ ] **Test 5: Image Field Disabled**
  - Uncheck `Image` in Website mode field settings $\rightarrow$ send link.
  - **Expected**: Only plain text message is sent (no photo attempted).
- [ ] **Test 6: Walmart Listing**
  - Send Walmart link (`https://www.walmart.com/ip/...`).
  - **Expected**: 500x500 square photo delivered with Walmart metadata.

---

## 🛡️ 7. Risks & Rollback Notes

- **Risk**: For products where caption $> 1,024$ chars, the user receives two messages instead of one.
  - **Mitigation**: This is an intentional behavior to satisfy Telegram API's hard 1,024-character caption limit without dropping the image.
- **Rollback Procedure**:
  - The changes are strictly isolated to [api/webhook.js](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js) and [routing/lib/telegram.js](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/routing/lib/telegram.js).
  - Can be reverted instantly via Git:
    ```bash
    git checkout api/webhook.js routing/lib/telegram.js
    ```

---

## 📌 8. Follow-Up Task (Separate from this Fix)
- **Vercel Webhook Timeout for Website / LinkedIn Modes**: Wrap lines 260–272 in `waitUntil(...)` in [api/webhook.js](file:///c:/Users/Admin/Desktop/Ajay/closeoutcenter/Code/Telegram-bot-vercel/api/webhook.js) so Vercel returns `200 OK` to Telegram immediately upon receipt, matching the architecture used in `mail` mode.
