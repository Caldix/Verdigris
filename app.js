/* ===========================================================
   Verdigris — app.js
   =========================================================== */

const DB_NAME = "copper-larder";
const DB_VERSION = 1;

let db = null;
let recipes = [];
let activeTag = null;     // lowercase tag string, or null for "All"
let searchTerm = "";
let viewMode = "grid";    // "grid" | "tag"

let currentImages = [];        // data URLs attached in the open form
let editingId = null;          // id of recipe being edited, or null for new
let detailRecipeId = null;     // id of recipe currently shown in detail dialog
let galleryIndex = 0;
let currentGalleryImages = [];

/* ----------------------- IndexedDB ----------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("recipes")) {
        d.createObjectStore("recipes", { keyPath: "id" });
      }
      if (!d.objectStoreNames.contains("pendingShare")) {
        d.createObjectStore("pendingShare", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("recipes", "readonly");
    const req = tx.objectStore("recipes").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(recipe) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("recipes", "readwrite");
    tx.objectStore("recipes").put(recipe);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("recipes", "readwrite");
    tx.objectStore("recipes").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetPendingShare() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingShare", "readonly");
    const req = tx.objectStore("pendingShare").get("pending");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function dbClearPendingShare() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pendingShare", "readwrite");
    tx.objectStore("pendingShare").delete("pending");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ----------------------- Helpers ----------------------- */

function uid() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseTags(raw) {
  const seen = new Set();
  const out = [];
  (raw || "").split(",").forEach((t) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  });
  return out;
}

function formatDate(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(ts));
  } catch {
    return "";
  }
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ----------------------- Rendering: tag bar ----------------------- */

function renderTagBar() {
  const bar = document.getElementById("tagBar");
  const section = document.getElementById("tagSection");
  const counts = new Map(); // lowercase -> { label, count }

  recipes.forEach((r) => {
    (r.tags || []).forEach((t) => {
      const key = t.toLowerCase();
      if (!counts.has(key)) counts.set(key, { label: t, count: 0 });
      counts.get(key).count++;
    });
  });

  section.hidden = counts.size === 0;
  if (counts.size === 0) return;

  const sorted = [...counts.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  const maxCount = Math.max(...sorted.map(([, info]) => info.count));

  bar.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "tag-chip" + (activeTag === null ? " is-active" : "");
  allChip.innerHTML = `All <span class="count">${recipes.length}</span>`;
  allChip.addEventListener("click", () => { activeTag = null; renderMain(); });
  bar.appendChild(allChip);

  sorted.forEach(([key, info]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    // simple tag-cloud effect: busier tags read a little bigger
    const ratio = info.count / maxCount;
    const sizeClass = ratio > 0.66 ? " size-3" : ratio > 0.33 ? " size-2" : "";
    chip.className = "tag-chip" + sizeClass + (activeTag === key ? " is-active" : "");
    chip.innerHTML = `${escapeHTML(info.label)} <span class="count">${info.count}</span>`;
    chip.addEventListener("click", () => {
      activeTag = activeTag === key ? null : key;
      renderMain();
    });
    bar.appendChild(chip);
  });
}

/* ----------------------- Filtering ----------------------- */

function matchesSearch(r, term) {
  if (!term) return true;
  const hay = [r.title, (r.tags || []).join(" "), r.notes, r.linkText, r.link]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
  return hay.includes(term);
}

function matchesTag(r, tagKey) {
  if (!tagKey) return true;
  return (r.tags || []).some((t) => t.toLowerCase() === tagKey);
}

function getFiltered() {
  const term = searchTerm.trim().toLowerCase();
  return recipes
    .filter((r) => matchesSearch(r, term) && matchesTag(r, activeTag))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ----------------------- Rendering: grid / groups ----------------------- */

function renderMain() {
  renderTagBar();
  const grid = document.getElementById("recipeGrid");
  const empty = document.getElementById("emptyState");
  const noResults = document.getElementById("noResults");
  grid.innerHTML = "";

  if (recipes.length === 0) {
    empty.hidden = false;
    noResults.hidden = true;
    return;
  }
  empty.hidden = true;

  const filtered = getFiltered();
  if (filtered.length === 0) {
    noResults.hidden = false;
    return;
  }
  noResults.hidden = true;

  if (viewMode === "grid") {
    filtered.forEach((r) => grid.appendChild(createCardEl(r)));
  } else {
    renderGroupedByTag(grid, filtered);
  }
}

function renderGroupedByTag(container, list) {
  const groups = new Map(); // lowercase -> { label, items }
  list.forEach((r) => {
    const tags = r.tags && r.tags.length ? r.tags : ["Untagged"];
    tags.forEach((t) => {
      const key = t.toLowerCase();
      if (!groups.has(key)) groups.set(key, { label: t, items: [] });
      groups.get(key).items.push(r);
    });
  });

  const sorted = [...groups.entries()].sort((a, b) => {
    if (a[0] === "untagged") return 1;
    if (b[0] === "untagged") return -1;
    return a[1].label.localeCompare(b[1].label);
  });

  sorted.forEach(([, group]) => {
    const wrap = document.createElement("div");
    wrap.className = "tag-group";
    const heading = document.createElement("div");
    heading.className = "tag-group-heading";
    heading.innerHTML = `<svg class="icon"><use href="#i-leaf"/></svg> ${escapeHTML(group.label)} <span class="count">${group.items.length}</span>`;
    wrap.appendChild(heading);

    const sub = document.createElement("div");
    sub.className = "recipe-grid";
    group.items.forEach((r) => sub.appendChild(createCardEl(r)));
    wrap.appendChild(sub);
    container.appendChild(wrap);
  });
}

function createCardEl(r) {
  const card = document.createElement("article");
  card.className = "recipe-card";
  card.tabIndex = 0;

  const pin = document.createElement("div");
  pin.className = "pin";
  card.appendChild(pin);

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "card-thumb-wrap";
  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  if (r.images && r.images.length) {
    const img = document.createElement("img");
    img.src = r.images[0];
    img.alt = "";
    thumb.appendChild(img);
    if (r.images.length > 1) {
      const badge = document.createElement("span");
      badge.className = "card-thumb-badge";
      badge.textContent = `+${r.images.length - 1}`;
      thumbWrap.appendChild(badge);
    }
  } else {
    thumb.innerHTML = `<svg class="icon"><use href="#i-whisk"/></svg>`;
  }
  thumbWrap.prepend(thumb);
  card.appendChild(thumbWrap);

  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = r.title || "Untitled recipe";
  card.appendChild(title);

  const snippetSource = r.notes || r.linkText || "";
  if (snippetSource) {
    const snippet = document.createElement("p");
    snippet.className = "card-snippet";
    snippet.textContent = snippetSource;
    card.appendChild(snippet);
  }

  if (r.tags && r.tags.length) {
    const tagsEl = document.createElement("div");
    tagsEl.className = "card-tags";
    r.tags.slice(0, 4).forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "mini-chip";
      chip.textContent = t;
      tagsEl.appendChild(chip);
    });
    card.appendChild(tagsEl);
  }

  const date = document.createElement("div");
  date.className = "card-date";
  date.innerHTML = r.link
    ? `<span class="card-link-flag"><svg class="icon"><use href="#i-link"/></svg> ${formatDate(r.updatedAt)}</span>`
    : formatDate(r.updatedAt);
  card.appendChild(date);

  card.addEventListener("click", () => openDetailModal(r.id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetailModal(r.id); }
  });

  return card;
}

/* ----------------------- New / Edit recipe modal ----------------------- */

const recipeModal = document.getElementById("recipeModal");
const recipeForm = document.getElementById("recipeForm");

function resetForm() {
  recipeForm.reset();
  document.getElementById("fId").value = "";
  document.getElementById("fTagsPreview").innerHTML = "";
  currentImages = [];
  renderImagePreviews();
  editingId = null;
}

function openNewRecipeModal(prefill) {
  resetForm();
  document.getElementById("recipeModalTitle").textContent = "New recipe";
  if (prefill) {
    document.getElementById("fTitle").value = prefill.title || "";
    document.getElementById("fNotes").value = prefill.text || "";
    document.getElementById("fLink").value = prefill.url || "";
    currentImages = prefill.images ? [...prefill.images] : [];
    renderImagePreviews();
  }
  recipeModal.showModal();
  document.getElementById("fTitle").focus();
}

function openEditRecipeModal(recipe) {
  resetForm();
  editingId = recipe.id;
  document.getElementById("recipeModalTitle").textContent = "Edit recipe";
  document.getElementById("fId").value = recipe.id;
  document.getElementById("fTitle").value = recipe.title || "";
  document.getElementById("fTags").value = (recipe.tags || []).join(", ");
  document.getElementById("fNotes").value = recipe.notes || "";
  document.getElementById("fLink").value = recipe.link || "";
  document.getElementById("fLinkText").value = recipe.linkText || "";
  currentImages = recipe.images ? [...recipe.images] : [];
  renderImagePreviews();
  renderTagsPreviewFromInput();
  recipeModal.showModal();
}

function closeRecipeModal() {
  recipeModal.close();
}

function renderTagsPreviewFromInput() {
  const preview = document.getElementById("fTagsPreview");
  const tags = parseTags(document.getElementById("fTags").value);
  preview.innerHTML = tags.map((t) => `<span class="mini-chip">${escapeHTML(t)}</span>`).join("");
}

function renderImagePreviews() {
  const list = document.getElementById("imagePreviewList");
  list.innerHTML = "";
  currentImages.forEach((src, idx) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";
    const img = document.createElement("img");
    img.src = src;
    img.style.cursor = "zoom-in";
    img.addEventListener("click", () => openLightbox(currentImages, idx));
    item.appendChild(img);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<svg class="icon"><use href="#i-close"/></svg>`;
    btn.addEventListener("click", () => {
      currentImages.splice(idx, 1);
      renderImagePreviews();
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

async function handleIncomingFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  for (const f of files) {
    try {
      const dataUrl = await fileToDataURL(f);
      currentImages.push(dataUrl);
    } catch (err) {
      console.error("Could not read image:", err);
    }
  }
  renderImagePreviews();
}

async function saveRecipeFromForm(e) {
  e.preventDefault();
  const title = document.getElementById("fTitle").value.trim();
  if (!title) {
    document.getElementById("fTitle").focus();
    return;
  }
  const now = Date.now();
  const id = editingId || uid();
  const existing = recipes.find((r) => r.id === id);

  const record = {
    id,
    title,
    tags: parseTags(document.getElementById("fTags").value),
    notes: document.getElementById("fNotes").value.trim(),
    link: document.getElementById("fLink").value.trim(),
    linkText: document.getElementById("fLinkText").value.trim(),
    images: [...currentImages],
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };

  await dbPut(record);
  recipes = await dbGetAll();
  closeRecipeModal();
  renderMain();
  showToast(editingId ? "Recipe updated" : "Recipe saved to your larder");
}

/* ----------------------- Detail modal ----------------------- */

const detailModal = document.getElementById("detailModal");

function openDetailModal(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  detailRecipeId = id;
  galleryIndex = 0;

  document.getElementById("detailTitle").textContent = r.title || "Untitled recipe";
  document.getElementById("detailMeta").textContent =
    `Saved ${formatDate(r.createdAt)}` + (r.updatedAt !== r.createdAt ? ` · edited ${formatDate(r.updatedAt)}` : "");

  const tagsEl = document.getElementById("detailTags");
  tagsEl.innerHTML = (r.tags || []).map((t) => `<span class="mini-chip">${escapeHTML(t)}</span>`).join("");

  const notesWrap = document.getElementById("detailNotesWrap");
  const notesEl = document.getElementById("detailNotes");
  if (r.notes) {
    notesEl.textContent = r.notes;
    notesWrap.hidden = false;
  } else {
    notesWrap.hidden = true;
  }

  const linkWrap = document.getElementById("detailLinkWrap");
  if (r.link) {
    const a = document.getElementById("detailLink");
    a.href = r.link;
    a.textContent = r.link;
    document.getElementById("detailLinkText").textContent = r.linkText || "(no recipe text saved from this link)";
    linkWrap.hidden = false;
  } else {
    linkWrap.hidden = true;
  }

  renderGallery(r.images || []);

  detailModal.showModal();
}

function renderGallery(images) {
  const gallery = document.getElementById("detailGallery");
  const track = document.getElementById("galleryTrack");
  const dots = document.getElementById("galleryDots");
  track.innerHTML = "";
  dots.innerHTML = "";
  currentGalleryImages = images;

  if (!images.length) {
    gallery.hidden = true;
    return;
  }
  gallery.hidden = false;

  images.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.addEventListener("click", () => openLightbox(images, i));
    track.appendChild(img);
  });
  images.forEach((_, i) => {
    const dot = document.createElement("span");
    if (i === 0) dot.classList.add("is-active");
    dots.appendChild(dot);
  });

  track.addEventListener("scroll", () => {
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    [...dots.children].forEach((d, i) => d.classList.toggle("is-active", i === idx));
    galleryIndex = idx;
  });
}

function scrollGallery(dir) {
  const track = document.getElementById("galleryTrack");
  track.scrollBy({ left: dir * track.clientWidth, behavior: "smooth" });
}

/* ----------------------- Lightbox (full-size image view) ----------------------- */

const lightbox = document.getElementById("lightbox");
let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(images, index) {
  lightboxImages = images;
  lightboxIndex = index;
  showLightboxImage();
  lightbox.showModal();
}

function showLightboxImage() {
  document.getElementById("lightboxImg").src = lightboxImages[lightboxIndex] || "";
  const multi = lightboxImages.length > 1;
  document.getElementById("lightboxPrev").hidden = !multi;
  document.getElementById("lightboxNext").hidden = !multi;
}

function lightboxStep(dir) {
  lightboxIndex = (lightboxIndex + dir + lightboxImages.length) % lightboxImages.length;
  showLightboxImage();
}

/* ----------------------- Export / Import ----------------------- */

function exportData() {
  const payload = {
    app: "verdigris",
    exportedAt: new Date().toISOString(),
    recipes
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `verdigris-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`);
}

async function importData(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = Array.isArray(parsed) ? parsed : parsed.recipes;
    if (!Array.isArray(incoming)) throw new Error("Unrecognized file format");

    const existingIds = new Set(recipes.map((r) => r.id));
    let added = 0;
    for (const item of incoming) {
      if (!item || !item.title) continue;
      const record = {
        id: existingIds.has(item.id) ? uid() : (item.id || uid()),
        title: item.title,
        tags: Array.isArray(item.tags) ? item.tags : parseTags(item.tags || ""),
        notes: item.notes || "",
        link: item.link || "",
        linkText: item.linkText || "",
        images: Array.isArray(item.images) ? item.images : [],
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now()
      };
      await dbPut(record);
      existingIds.add(record.id);
      added++;
    }
    recipes = await dbGetAll();
    renderMain();
    showToast(`Imported ${added} recipe${added === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(err);
    showToast("Couldn't read that file — is it a Verdigris export?");
  }
}

/* ----------------------- Share target intake ----------------------- */

async function checkPendingShare() {
  const params = new URLSearchParams(location.search);
  if (params.get("shared") !== "1") return;
  history.replaceState(null, "", location.pathname);

  const pending = await dbGetPendingShare();
  if (!pending) return;
  await dbClearPendingShare();

  openNewRecipeModal({
    title: pending.title,
    text: pending.text,
    url: pending.url,
    images: pending.images
  });
  showToast("Shared content loaded — review and save");
}

/* ----------------------- Wiring ----------------------- */

function wireEvents() {
  document.getElementById("newRecipeBtn").addEventListener("click", () => openNewRecipeModal());
  document.getElementById("emptyStateAddBtn").addEventListener("click", () => openNewRecipeModal());
  document.getElementById("closeRecipeModal").addEventListener("click", closeRecipeModal);
  document.getElementById("cancelRecipeBtn").addEventListener("click", closeRecipeModal);
  recipeForm.addEventListener("submit", saveRecipeFromForm);
  document.getElementById("fTags").addEventListener("input", renderTagsPreviewFromInput);

  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchTerm = e.target.value;
    renderMain();
  });

  document.getElementById("viewGridBtn").addEventListener("click", () => setView("grid"));
  document.getElementById("viewTagBtn").addEventListener("click", () => setView("tag"));

  // image input
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fImages");
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", (e) => handleIncomingFiles(e.target.files));

  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("is-drag"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("is-drag"); })
  );
  dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleIncomingFiles(e.dataTransfer.files);
  });

  // paste images anywhere inside the open form (covers WhatsApp Web / desktop copy-paste of screenshots)
  recipeForm.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [...items].filter((it) => it.kind === "file" && it.type.startsWith("image/")).map((it) => it.getAsFile());
    if (files.length) handleIncomingFiles(files);
  });

  // detail modal
  document.getElementById("closeDetailModal").addEventListener("click", () => detailModal.close());
  document.getElementById("galleryPrev").addEventListener("click", () => scrollGallery(-1));
  document.getElementById("galleryNext").addEventListener("click", () => scrollGallery(1));
  document.getElementById("editRecipeBtn").addEventListener("click", () => {
    const r = recipes.find((x) => x.id === detailRecipeId);
    detailModal.close();
    if (r) openEditRecipeModal(r);
  });
  document.getElementById("deleteRecipeBtn").addEventListener("click", async () => {
    const r = recipes.find((x) => x.id === detailRecipeId);
    if (!r) return;
    if (!confirm(`Delete "${r.title}"? This can't be undone.`)) return;
    await dbDelete(r.id);
    recipes = await dbGetAll();
    detailModal.close();
    renderMain();
    showToast("Recipe deleted");
  });

  // export / import
  document.getElementById("exportBtn").addEventListener("click", exportData);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });

  // lightbox
  document.getElementById("closeLightbox").addEventListener("click", () => lightbox.close());
  document.getElementById("lightboxPrev").addEventListener("click", () => lightboxStep(-1));
  document.getElementById("lightboxNext").addEventListener("click", () => lightboxStep(1));
  lightbox.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") lightboxStep(-1);
    if (e.key === "ArrowRight") lightboxStep(1);
  });

  // close dialogs on backdrop click
  [recipeModal, detailModal, lightbox].forEach((dlg) => {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  });
}

function setView(mode) {
  viewMode = mode;
  document.getElementById("viewGridBtn").classList.toggle("is-active", mode === "grid");
  document.getElementById("viewGridBtn").setAttribute("aria-pressed", mode === "grid");
  document.getElementById("viewTagBtn").classList.toggle("is-active", mode === "tag");
  document.getElementById("viewTagBtn").setAttribute("aria-pressed", mode === "tag");
  renderMain();
}

/* ----------------------- Boot ----------------------- */

async function boot() {
  db = await openDB();
  recipes = await dbGetAll();
  wireEvents();
  renderMain();
  await checkPendingShare();

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  }
}

document.addEventListener("DOMContentLoaded", boot);
