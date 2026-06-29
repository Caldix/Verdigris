// Verdigris — service worker
// Network-first caching (so new deploys aren't stuck behind a stale cache),
// plus handling of the Web Share Target POST.

const CACHE_NAME = "copper-thyme-v1";
const CORE_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ---- tiny IndexedDB helper, scoped just to writing a single "pendingShare" record ----
function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("copper-larder", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("recipes")) {
        db.createObjectStore("recipes", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("pendingShare")) {
        db.createObjectStore("pendingShare", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fileToDataURL(file) {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${file.type || "image/png"};base64,${btoa(binary)}`;
}

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const title = formData.get("title") || "";
    const text = formData.get("text") || "";
    const url = formData.get("url") || "";
    const files = formData.getAll("images").filter((f) => f && f.size > 0);

    const images = [];
    for (const f of files) {
      images.push(await fileToDataURL(f));
    }

    const db = await openShareDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pendingShare", "readwrite");
      tx.objectStore("pendingShare").put({
        id: "pending",
        title,
        text,
        url,
        images,
        createdAt: Date.now()
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // If anything goes wrong, we still redirect so the user lands in the app.
    console.error("Share target handling failed:", err);
  }
  return Response.redirect("./index.html?shared=1", 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle the Web Share Target POST
  if (request.method === "POST" && url.pathname.endsWith("/index.html")) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== "GET") return;

  // Network-first for everything else, falling back to cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
