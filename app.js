import { db, collection, doc, getDoc, getDocs, updateDoc, query, where, limit, orderBy, arrayUnion } from "./firebase-config.js";
import { hashPassword, randomSalt, tierMeta, avatarHtml, isFoundingMember } from "./utils.js";
import { t, getLang, setLang, applyStaticTranslations } from "./i18n.js";

const $ = (id) => document.getElementById(id);

const viewLogin = $("view-login");
const viewApp = $("view-app");
const viewSettings = $("view-settings");
const tabbar = $("tabbar");
const settingsBtn = $("settings-btn");
const settingsBackBtn = $("settings-back-btn");

let currentPlayer = null; // { id, ...data }
let lastTabBeforeSettings = "home";

// ---------------- session ----------------
function saveSession(playerId) {
  localStorage.setItem("kfs_player_id", playerId);
}
function clearSession() {
  localStorage.removeItem("kfs_player_id");
}
function getSession() {
  return localStorage.getItem("kfs_player_id");
}

// ---------------- rendering ----------------
// Pure DOM update — safe to call any time (login, avatar change, language switch)
// without touching which view/tab is currently visible.
function refreshProfileDisplay(player) {
  $("pf-avatar").innerHTML = avatarHtml(player);
  $("pf-avatar").classList.toggle("founding-ring", isFoundingMember(player));
  $("pf-name").textContent = player.name || "—";
  $("pf-code").textContent = player.playerCode || "—";

  const meta = tierMeta(player.currentTier);
  $("pf-shield").textContent = meta.level || "-";
  $("pf-shield").className = "tier-shield " + meta.cssClass;
  $("pf-tier-name").textContent = meta.displayName;
  $("pf-points").textContent = `${Math.round(player.ratingPoints ?? 1000)} ${t("pts")}`;

  $("pf-matches").textContent = player.matchesPlayed ?? 0;
  $("pf-wins").textContent = player.wins ?? 0;
  $("pf-losses").textContent = player.losses ?? 0;
  const matches = player.matchesPlayed ?? 0;
  const wins = player.wins ?? 0;
  $("pf-winrate").textContent = matches > 0 ? `${Math.round((wins / matches) * 100)}%` : "—";

  const memberSince = player.createdAt?.toDate ? player.createdAt.toDate() : null;
  $("pf-member-since").textContent = memberSince
    ? memberSince.toLocaleDateString(getLang() === "ar" ? "ar-EG" : "en-US", { month: "short", year: "numeric" })
    : "—";

  renderBadges(player);

  // settings mini profile
  $("st-avatar").innerHTML = avatarHtml(player);
  $("st-name").textContent = player.name || "—";
  $("st-code").textContent = player.playerCode || "—";
}

// Login entry point: updates the display AND navigates into the app.
function renderProfile(player) {
  currentPlayer = player;
  refreshProfileDisplay(player);

  viewLogin.classList.add("hidden");
  viewApp.classList.remove("hidden");
  tabbar.classList.remove("hidden");
  settingsBtn.classList.remove("hidden");
  switchTab("home");
  loadHome();
}

// ---------------- badges ----------------
function renderBadges(player) {
  const el = $("pf-badges");
  el.innerHTML = "";

  if (isFoundingMember(player)) {
    el.innerHTML += `<span class="badge-pill founding">🌟 ${t("badge_founding")}</span>`;
  }

  const matches = player.matchesPlayed ?? 0;
  let activityKey = "badge_new";
  if (matches >= 15) activityKey = "badge_veteran";
  else if (matches >= 3) activityKey = "badge_regular";
  el.innerHTML += `<span class="badge-pill activity">${t(activityKey)}</span>`;
}

function showLogin() {
  currentPlayer = null;
  viewApp.classList.add("hidden");
  viewSettings.classList.add("hidden");
  tabbar.classList.add("hidden");
  settingsBtn.classList.add("hidden");
  settingsBackBtn.classList.add("hidden");
  viewLogin.classList.remove("hidden");
}

// ---------------- settings screen ----------------
settingsBtn.addEventListener("click", () => {
  lastTabBeforeSettings = document.querySelector(".tab-btn.active")?.dataset.tab || "home";
  viewApp.classList.add("hidden");
  viewSettings.classList.remove("hidden");
  tabbar.classList.add("hidden");
  settingsBtn.classList.add("hidden");
  settingsBackBtn.classList.remove("hidden");
  updateLangButtons();
});

settingsBackBtn.addEventListener("click", () => {
  viewSettings.classList.add("hidden");
  viewApp.classList.remove("hidden");
  tabbar.classList.remove("hidden");
  settingsBtn.classList.remove("hidden");
  settingsBackBtn.classList.add("hidden");
  switchTab(lastTabBeforeSettings);
});

function updateLangButtons() {
  const lang = getLang();
  $("lang-ar-btn").classList.toggle("active", lang === "ar");
  $("lang-en-btn").classList.toggle("active", lang === "en");
}

$("lang-ar-btn").addEventListener("click", () => switchLanguage("ar"));
$("lang-en-btn").addEventListener("click", () => switchLanguage("en"));

function switchLanguage(lang) {
  if (getLang() === lang) return;
  setLang(lang);
  applyStaticTranslations();
  updateLangButtons();
  // re-render dynamic content in place (no navigation) so translated labels refresh
  // even while the Settings screen stays open.
  if (currentPlayer) {
    refreshProfileDisplay(currentPlayer);
    loadHome(); // safe: only updates Home tab content, no view/tab navigation
  }
}

// ---------------- avatar upload ----------------
$("avatar-edit-btn").addEventListener("click", () => $("avatar-input").click());
$("change-photo-link").addEventListener("click", () => $("avatar-input").click());

$("avatar-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 200);
    await updateDoc(doc(db, "players", currentPlayer.id), { avatarUrl: dataUrl });
    currentPlayer.avatarUrl = dataUrl;
    refreshProfileDisplay(currentPlayer);
    leaderboardCache = null; // photo should show next time leaderboard loads
  } catch (err) {
    console.error(err);
  } finally {
    e.target.value = "";
  }
});

function resizeImageToDataUrl(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- tabs ----------------
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  home: $("tab-home"),
  tournaments: $("tab-tournaments"),
  marketplace: $("tab-marketplace"),
  leaderboard: $("tab-leaderboard"),
  profile: $("tab-profile")
};
let leaderboardCache = null; // array of {id, rank, ...data}, shared between Home + Leaderboard tabs
let tournamentsCache = null; // array of {id, ...data}, shared between Home + Tournaments tabs

function switchTab(target) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === target));
  Object.entries(tabPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== target);
  });
  if (target === "leaderboard") loadLeaderboard();
  if (target === "tournaments") loadTournamentsTab();
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.querySelectorAll(".view-all[data-goto]").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.goto));
});

// ---------------- shared leaderboard data ----------------
async function ensureLeaderboardData(forceRefresh = false) {
  if (leaderboardCache && !forceRefresh) return leaderboardCache;
  const q = query(
    collection(db, "players"),
    where("isActive", "==", true),
    orderBy("ratingPoints", "desc")
  );
  const snap = await getDocs(q);
  leaderboardCache = snap.docs.map((d, i) => ({ id: d.id, rank: i + 1, ...d.data() }));
  return leaderboardCache;
}

// ---------------- home tab ----------------
async function loadHome() {
  $("home-greeting").textContent = `${t("home_greeting_prefix")} ${(currentPlayer.name || "").split(" ")[0] || ""} 👋`;
  $("hm-code").textContent = currentPlayer.playerCode || "—";

  const meta = tierMeta(currentPlayer.currentTier);
  $("hm-shield").textContent = meta.level || "-";
  $("hm-shield").className = "tier-shield " + meta.cssClass;
  $("hm-tier-name").textContent = meta.displayName;
  $("hm-points").textContent = `${Math.round(currentPlayer.ratingPoints ?? 1000)} ${t("pts")}`;

  loadAnnouncement();
  loadHomeTournaments();

  try {
    const data = await ensureLeaderboardData();
    const mine = data.find((p) => p.id === currentPlayer.id);
    $("hm-rank-value").textContent = mine ? `#${mine.rank} ${t("of")} ${data.length}` : "—";
    renderTopPlayers(data.slice(0, 3));
    if (mine) updateRankTrend(mine.rank);
  } catch (err) {
    console.error(err);
    $("hm-rank-value").textContent = "—";
  }
}

// ---------------- rank trend (weekly snapshot, purely client-driven) ----------------
async function updateRankTrend(currentRank) {
  const trendEl = $("hm-rank-trend");
  const snapshot = currentPlayer.rankSnapshot;
  const now = Date.now();
  const snapshotDate = snapshot?.capturedAt?.toDate ? snapshot.capturedAt.toDate().getTime() : null;
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  if (snapshot && typeof snapshot.rank === "number") {
    const diff = snapshot.rank - currentRank; // positive = moved up (better)
    trendEl.classList.remove("hidden", "up", "down", "flat");
    if (diff > 0) {
      trendEl.textContent = `▲${diff}`;
      trendEl.classList.add("up");
    } else if (diff < 0) {
      trendEl.textContent = `▼${Math.abs(diff)}`;
      trendEl.classList.add("down");
    } else {
      trendEl.textContent = t("rank_no_change");
      trendEl.classList.add("flat");
    }
  } else {
    trendEl.classList.add("hidden");
  }

  // refresh the snapshot once a week so the next login shows a fresh comparison
  if (!snapshotDate || (now - snapshotDate) > weekMs) {
    try {
      await updateDoc(doc(db, "players", currentPlayer.id), {
        rankSnapshot: { rank: currentRank, capturedAt: new Date() }
      });
      currentPlayer.rankSnapshot = { rank: currentRank, capturedAt: { toDate: () => new Date() } };
    } catch (err) {
      console.error(err);
    }
  }
}

function renderTopPlayers(list) {
  const el = $("hm-top-players");
  el.innerHTML = "";
  list.forEach((p) => {
    const isMe = p.id === currentPlayer.id;
    const meta = tierMeta(p.currentTier);
    const founding = isFoundingMember(p);
    const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
    const row = document.createElement("div");
    row.className = "lb-row" + (isMe ? " me" : "");
    row.innerHTML = `
      <span class="lb-rank ${rankClass}">${p.rank}</span>
      <span class="lb-avatar${founding ? " founding-ring" : ""}">${avatarHtml(p)}</span>
      <span class="lb-mid">
        <div class="lb-name">${founding ? '<span class="founding-star" title="Founding Member">🌟</span> ' : ""}${p.name || "—"}${isMe ? " " + t("you_suffix") : ""}</div>
        <div class="lb-tier">${meta.displayName}</div>
      </span>
      <span class="lb-points">${Math.round(p.ratingPoints ?? 1000)}</span>
    `;
    el.appendChild(row);
  });
}

async function loadAnnouncement() {
  try {
    const snap = await getDoc(doc(db, "config", "announcement"));
    const bar = $("announcement-bar");
    if (snap.exists() && snap.data().active && snap.data().text) {
      $("announcement-text").textContent = snap.data().text;
      bar.classList.remove("hidden");
    } else {
      bar.classList.add("hidden");
    }
  } catch (err) {
    console.error(err);
  }
}

// ---------------- tournaments (shared data) ----------------
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>';
const CAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>';

function statusLabel(status) {
  if (status === "live") return t("status_live");
  if (status === "upcoming") return t("status_upcoming");
  return t("status_completed");
}

async function ensureTournamentsData(forceRefresh = false) {
  if (tournamentsCache && !forceRefresh) return tournamentsCache;
  const q = query(collection(db, "tournaments"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  tournamentsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return tournamentsCache;
}

function tourneyCardHtml(tr) {
  const statusDot = tr.status === "live" ? '<span class="dot-live"></span>' : "";
  return `
    <span class="tourney-status ${tr.status || "upcoming"}">${statusDot}${statusLabel(tr.status)}</span>
    <div class="tourney-name">${tr.name || "—"}</div>
    ${tr.location ? `<div class="tourney-meta">${PIN_SVG}${tr.location}</div>` : ""}
    ${tr.dateLabel ? `<div class="tourney-meta">${CAL_SVG}${tr.dateLabel}</div>` : ""}
  `;
}

async function loadHomeTournaments() {
  const loadingEl = $("hm-tourney-loading");
  const scrollEl = $("hm-tourney-scroll");
  const emptyEl = $("hm-tourney-empty");
  loadingEl.classList.remove("hidden");
  scrollEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  try {
    const data = await ensureTournamentsData();
    loadingEl.classList.add("hidden");
    if (data.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    scrollEl.innerHTML = "";
    data.slice(0, 8).forEach((tr) => {
      const card = document.createElement("div");
      card.className = "tourney-card";
      card.innerHTML = tourneyCardHtml(tr);
      card.addEventListener("click", () => switchTab("tournaments"));
      scrollEl.appendChild(card);
    });
    scrollEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

async function loadTournamentsTab() {
  const loadingEl = $("tr-loading");
  const listEl = $("tr-list");
  const emptyEl = $("tr-empty");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  try {
    const data = await ensureTournamentsData(true);
    loadingEl.classList.add("hidden");
    if (data.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    listEl.innerHTML = "";
    data.forEach((tr) => {
      const row = document.createElement("div");
      row.className = "tourney-row";
      const isRegistered = (tr.participantIds || []).includes(currentPlayer.id);
      let actionHtml = "";
      if (tr.status === "upcoming") {
        actionHtml = isRegistered
          ? `<div class="tourney-actions"><button class="btn btn-ghost btn-sm" disabled>${t("registered_btn")}</button></div>`
          : `<div class="tourney-actions"><button class="btn btn-primary btn-sm" data-register="${tr.id}">${t("register_btn")}</button></div>`;
      }
      row.innerHTML = `
        <div class="tourney-row-top">
          <div>
            <span class="tourney-status ${tr.status || "upcoming"}">${tr.status === "live" ? '<span class="dot-live"></span>' : ""}${statusLabel(tr.status)}</span>
            <div class="tourney-name">${tr.name || "—"}</div>
          </div>
        </div>
        ${tr.location ? `<div class="tourney-meta">${PIN_SVG}${tr.location}</div>` : ""}
        ${tr.dateLabel ? `<div class="tourney-meta">${CAL_SVG}${tr.dateLabel}</div>` : ""}
        ${tr.championName ? `<div class="tourney-champion">🏆 ${t("champion_label")}: ${tr.championName}</div>` : ""}
        ${actionHtml}
      `;
      listEl.appendChild(row);
    });
    listEl.classList.remove("hidden");

    listEl.querySelectorAll("[data-register]").forEach((btn) => {
      btn.addEventListener("click", () => registerForTournament(btn.dataset.register, btn));
    });
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

async function registerForTournament(tournamentId, btn) {
  btn.disabled = true;
  btn.textContent = t("registering");
  try {
    await updateDoc(doc(db, "tournaments", tournamentId), {
      participantIds: arrayUnion(currentPlayer.id)
    });
    btn.textContent = t("registered_btn");
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-ghost");
    const cached = tournamentsCache?.find((tr) => tr.id === tournamentId);
    if (cached) {
      cached.participantIds = [...(cached.participantIds || []), currentPlayer.id];
    }
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = t("register_btn");
  }
}

// ---------------- leaderboard tab ----------------
async function loadLeaderboard() {
  const loadingEl = $("lb-loading");
  const listEl = $("lb-list");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");

  try {
    const data = await ensureLeaderboardData();
    listEl.innerHTML = "";

    data.forEach((p) => {
      const isMe = p.id === currentPlayer.id;
      const meta = tierMeta(p.currentTier);
      const founding = isFoundingMember(p);
      const li = document.createElement("li");
      li.className = "lb-row" + (isMe ? " me" : "");
      const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
      li.innerHTML = `
        <span class="lb-rank ${rankClass}">${p.rank}</span>
        <span class="lb-avatar${founding ? " founding-ring" : ""}">${avatarHtml(p)}</span>
        <span class="lb-mid">
          <div class="lb-name">${founding ? '<span class="founding-star" title="Founding Member">🌟</span> ' : ""}${p.name || "—"}${isMe ? " " + t("you_suffix") : ""}</div>
          <div class="lb-tier">${meta.displayName}</div>
        </span>
        <span class="lb-points">${Math.round(p.ratingPoints ?? 1000)}</span>
      `;
      listEl.appendChild(li);
    });

    const mine = data.find((p) => p.id === currentPlayer.id);
    $("my-rank-value").textContent = mine ? `#${mine.rank} ${t("of")} ${data.length}` : "—";

    loadingEl.classList.add("hidden");
    listEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

function showMsg(el, text) {
  el.textContent = text;
  el.classList.add("show");
}
function hideMsg(el) {
  el.classList.remove("show");
  el.textContent = "";
}

// ---------------- data ----------------
async function findPlayerByCode(code) {
  const q = query(collection(db, "players"), where("playerCode", "==", code), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

async function loadPlayerById(playerId) {
  const ref = doc(db, "players", playerId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// ---------------- login ----------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("login-error");
  hideMsg(errEl);

  const codeRaw = $("login-code").value.trim().toUpperCase();
  const pass = $("login-pass").value.trim();
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = t("login_signing_in");

  try {
    const player = await findPlayerByCode(codeRaw);
    if (!player) {
      showMsg(errEl, t("login_err_no_code"));
      return;
    }
    const computedHash = await hashPassword(pass, player.passwordSalt || "");
    if (computedHash !== player.passwordHash) {
      showMsg(errEl, t("login_err_wrong_pass"));
      return;
    }
    saveSession(player.id);
    renderProfile(player);
  } catch (err) {
    console.error(err);
    showMsg(errEl, t("login_err_generic"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("login_btn");
  }
});

// ---------------- change password (in Settings) ----------------
$("change-pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("pass-error");
  const okEl = $("pass-success");
  hideMsg(errEl);
  hideMsg(okEl);

  const current = $("cp-current").value.trim();
  const next = $("cp-new").value.trim();
  const confirm = $("cp-confirm").value.trim();

  if (next !== confirm) {
    showMsg(errEl, t("pass_err_mismatch"));
    return;
  }
  if (next.length < 6) {
    showMsg(errEl, t("pass_err_short"));
    return;
  }

  const btn = $("cp-btn");
  btn.disabled = true;
  btn.textContent = t("settings_saving");

  try {
    const computedCurrentHash = await hashPassword(current, currentPlayer.passwordSalt || "");
    if (computedCurrentHash !== currentPlayer.passwordHash) {
      showMsg(errEl, t("pass_err_wrong_current"));
      return;
    }
    const newSalt = randomSalt();
    const newHash = await hashPassword(next, newSalt);
    await updateDoc(doc(db, "players", currentPlayer.id), {
      passwordSalt: newSalt,
      passwordHash: newHash
    });
    currentPlayer.passwordSalt = newSalt;
    currentPlayer.passwordHash = newHash;
    showMsg(okEl, t("pass_success"));
    $("cp-current").value = "";
    $("cp-new").value = "";
    $("cp-confirm").value = "";
  } catch (err) {
    console.error(err);
    showMsg(errEl, t("pass_err_generic"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings_save_pass");
  }
});

// ---------------- share profile card ----------------
$("share-card-btn").addEventListener("click", generateAndShareProfileCard);

async function generateAndShareProfileCard() {
  const btn = $("share-card-btn");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = t("profile_share_generating");

  try {
    await document.fonts.ready;
    const canvas = $("share-canvas");
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;

    // background
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#10201f");
    grad.addColorStop(1, "#040a09");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = "center";

    // brand
    ctx.fillStyle = "#c9f24c";
    ctx.beginPath();
    ctx.arc(W / 2 - 92, 96, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "700 30px 'Space Mono', monospace";
    ctx.fillStyle = "rgba(245,243,234,0.85)";
    ctx.fillText("KFS PADEL RANKING", W / 2 + 30, 106);

    // avatar
    const avatarSize = 260;
    const avatarY = 240;
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (currentPlayer.avatarUrl) {
      const img = await loadImage(currentPlayer.avatarUrl);
      ctx.drawImage(img, W / 2 - avatarSize / 2, avatarY, avatarSize, avatarSize);
    } else {
      ctx.fillStyle = "#16302d";
      ctx.fillRect(W / 2 - avatarSize / 2, avatarY, avatarSize, avatarSize);
      ctx.fillStyle = "#c9f24c";
      ctx.font = "800 110px 'Cairo', sans-serif";
      ctx.fillText((currentPlayer.name || "?").trim().charAt(0).toUpperCase(), W / 2, avatarY + avatarSize / 2 + 38);
    }
    ctx.restore();

    // name
    ctx.fillStyle = "#f5f3ea";
    ctx.font = "900 62px 'Cairo', sans-serif";
    ctx.fillText(currentPlayer.name || "—", W / 2, avatarY + avatarSize + 90);

    // code
    ctx.font = "700 30px 'Space Mono', monospace";
    ctx.fillStyle = "rgba(245,243,234,0.5)";
    ctx.fillText(currentPlayer.playerCode || "", W / 2, avatarY + avatarSize + 140);

    // tier pill
    const meta = tierMeta(currentPlayer.currentTier);
    const tierColors = { gold: "#e3b74e", silver: "#b9c2c8", bronze: "#b98a5a" };
    const pillY = avatarY + avatarSize + 200;
    ctx.font = "800 34px 'Cairo', sans-serif";
    const pillText = meta.displayName;
    const pillWidth = ctx.measureText(pillText).width + 80;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, W / 2 - pillWidth / 2, pillY - 44, pillWidth, 76, 38);
    ctx.fill();
    ctx.fillStyle = tierColors[meta.cssClass] || "#c9f24c";
    ctx.fillText(pillText, W / 2, pillY + 8);

    // stats row
    const statsY = pillY + 150;
    const stats = [
      [`${Math.round(currentPlayer.ratingPoints ?? 1000)}`, t("pts")],
      [`${currentPlayer.matchesPlayed ?? 0}`, t("profile_matches")],
      [(currentPlayer.matchesPlayed ?? 0) > 0 ? `${Math.round(((currentPlayer.wins ?? 0) / currentPlayer.matchesPlayed) * 100)}%` : "—", t("profile_winrate")]
    ];
    const colWidth = W / 3;
    stats.forEach((s, i) => {
      const cx = colWidth * i + colWidth / 2;
      ctx.font = "800 52px 'Space Mono', monospace";
      ctx.fillStyle = "#f5f3ea";
      ctx.fillText(s[0], cx, statsY);
      ctx.font = "600 26px 'Cairo', sans-serif";
      ctx.fillStyle = "rgba(245,243,234,0.55)";
      ctx.fillText(s[1], cx, statsY + 46);
    });

    // footer
    ctx.font = "600 26px 'Cairo', sans-serif";
    ctx.fillStyle = "rgba(245,243,234,0.35)";
    ctx.fillText("kfspadel", W / 2, H - 60);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
    const fileName = `kfs-padel-${(currentPlayer.playerCode || "profile").toLowerCase()}.png`;
    const file = new File([blob], fileName, { type: "image/png" });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "KFS Padel Ranking" });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------- logout ----------------
$("logout-btn").addEventListener("click", () => {
  clearSession();
  leaderboardCache = null;
  tournamentsCache = null;
  showLogin();
});

// ---------------- bootstrap ----------------
applyStaticTranslations();

(async function init() {
  const savedId = getSession();
  if (!savedId) return;
  try {
    const player = await loadPlayerById(savedId);
    if (player) {
      renderProfile(player);
    } else {
      clearSession();
    }
  } catch (err) {
    console.error(err);
  }
})();

// ---------------- register service worker ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  });
}
