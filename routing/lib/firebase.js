require("./env");
const admin = require("firebase-admin");

let db = null;
let isFirebaseReady = false;

try {
  if (!admin.apps || admin.apps.length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey || privateKey.length < 100) {
      console.error("[firebase] MISSING or INVALID env vars:",
        { projectId: !!projectId, clientEmail: !!clientEmail, privateKeyLen: privateKey.length });
    } else {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
      db = admin.firestore();
      isFirebaseReady = true;
      console.log("[firebase] Initialized successfully, project:", projectId);
    }
  } else {
    db = admin.firestore();
    isFirebaseReady = true;
  }
} catch (err) {
  console.error("[firebase] Init error:", err.message);
}

module.exports = { admin, db, isFirebaseReady };