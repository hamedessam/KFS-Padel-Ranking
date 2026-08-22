import { db, collection, doc, getDoc, getDocs, updateDoc, query, where, limit, orderBy, arrayUnion } from "./firebase-config.js";
import { hashPassword, randomSalt, tierMeta } from "./utils.js";

const $ = (id) => document.getElementById(id);

const viewLogin = $("view-login");
const viewApp = $("view-app");
const tabbar = $("tabbar");
const settingsBtn = $("settings-btn");

let currentPlayer = null; // { id, ...data }

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
function renderProfile(player) {
  currentPlayer = player;
  $("pf-avatar").textContent = (player.name || "?").trim().charAt(0);
  $("pf-name").textContent = player.name || "—";
  $("pf-code").textContent = player.playerCode || "—";

  const meta = tierMeta(player.currentTier);
  $("pf-shield").textContent = meta.level || "-";
  $("pf-shield").className = "tier-shield " + meta.cssClass;
  $("pf-tier-name").textContent = meta.displayName;
  $("pf-points").textContent = `${Math.round(player.ratingPoints ?? 1000)} pts`;

  $("pf-matches").textContent = player.matchesPlayed ?? 0;
  $("pf-wins").textContent = player.wins ?? 0;
  $("pf-losses").textContent = player.losses ?? 0;

  viewLogin.classList.add("hidden");
  viewApp.classList.remove("hidden");
  tabbar.classList.remove("hidden");
  settingsBtn.classList.remove("hidden");
  switchTab("home");
  loadHome();
}

function showLogin() {
  currentPlayer = null;
  viewApp.classList.add("hidden");
  tabbar.classList.add("hidden");
  settingsBtn.classList.add("hidden");
  viewLogin.classList.remove("hidden");
}

settingsBtn.addEventListener("click", () => switchTab("profile"));

// ---------------- tabs ----------------
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  home: $("tab-home"),
  tournaments: $("tab-tournaments"),
  leaderboard: $("tab-leaderboard"),
  profile: $("tab-profile"),
  marketplace: $("tab-marketplace")
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
  $("home-greeting").textContent = `Hey ${(currentPlayer.name || "").split(" ")[0] || ""} 👋`;

  const meta = tierMeta(currentPlayer.currentTier);
  $("hm-shield").textContent = meta.level || "-";
  $("hm-shield").className = "tier-shield " + meta.cssClass;
  $("hm-tier-name").textContent = meta.displayName;
  $("hm-points").textContent = `${Math.round(currentPlayer.ratingPoints ?? 1000)} pts`;

  loadAnnouncement();
  loadHomeTournaments();

  try {
    const data = await ensureLeaderboardData();
    const mine = data.find((p) => p.id === currentPlayer.id);
    $("hm-rank-value").textContent = mine ? `#${mine.rank} of ${data.length}` : "—";
    renderTopPlayers(data.slice(0, 3));
  } catch (err) {
    console.error(err);
    $("hm-rank-value").textContent = "—";
  }
}

function renderTopPlayers(list) {
  const el = $("hm-top-players");
  el.innerHTML = "";
  list.forEach((p) => {
    const isMe = p.id === currentPlayer.id;
    const meta = tierMeta(p.currentTier);
    const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
    const row = document.createElement("div");
    row.className = "lb-row" + (isMe ? " me" : "");
    row.innerHTML = `
      <span class="lb-rank ${rankClass}">${p.rank}</span>
      <span class="lb-avatar">${(p.name || "?").trim().charAt(0)}</span>
      <span class="lb-mid">
        <div class="lb-name">${p.name || "—"}${isMe ? " (you)" : ""}</div>
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

async function ensureTournamentsData(forceRefresh = false) {
  if (tournamentsCache && !forceRefresh) return tournamentsCache;
  const q = query(collection(db, "tournaments"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  tournamentsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return tournamentsCache;
}

function tourneyCardHtml(t) {
  const statusLabel = t.status === "live" ? "Live" : t.status === "upcoming" ? "Upcoming" : "Completed";
  const statusDot = t.status === "live" ? '<span class="dot-live"></span>' : "";
  return `
    <span class="tourney-status ${t.status || "upcoming"}">${statusDot}${statusLabel}</span>
    <div class="tourney-name">${t.name || "Untitled tournament"}</div>
    ${t.location ? `<div class="tourney-meta">${PIN_SVG}${t.location}</div>` : ""}
    ${t.dateLabel ? `<div class="tourney-meta">${CAL_SVG}${t.dateLabel}</div>` : ""}
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
    data.slice(0, 8).forEach((t) => {
      const card = document.createElement("div");
      card.className = "tourney-card";
      card.innerHTML = tourneyCardHtml(t);
      card.addEventListener("click", () => switchTab("tournaments"));
      scrollEl.appendChild(card);
    });
    scrollEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load tournaments.";
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
    data.forEach((t) => {
      const row = document.createElement("div");
      row.className = "tourney-row";
      const isRegistered = (t.participantIds || []).includes(currentPlayer.id);
      let actionHtml = "";
      if (t.status === "upcoming") {
        actionHtml = isRegistered
          ? `<div class="tourney-actions"><button class="btn btn-ghost btn-sm" disabled>Registered ✓</button></div>`
          : `<div class="tourney-actions"><button class="btn btn-primary btn-sm" data-register="${t.id}">Register</button></div>`;
      }
      row.innerHTML = `
        <div class="tourney-row-top">
          <div>
            <span class="tourney-status ${t.status || "upcoming"}">${t.status === "live" ? '<span class="dot-live"></span>Live' : t.status === "upcoming" ? "Upcoming" : "Completed"}</span>
            <div class="tourney-name">${t.name || "Untitled tournament"}</div>
          </div>
        </div>
        ${t.location ? `<div class="tourney-meta">${PIN_SVG}${t.location}</div>` : ""}
        ${t.dateLabel ? `<div class="tourney-meta">${CAL_SVG}${t.dateLabel}</div>` : ""}
        ${t.championName ? `<div class="tourney-champion">🏆 Champion: ${t.championName}</div>` : ""}
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
    loadingEl.textContent = "Couldn't load tournaments.";
  }
}

async function registerForTournament(tournamentId, btn) {
  btn.disabled = true;
  btn.textContent = "Registering...";
  try {
    await updateDoc(doc(db, "tournaments", tournamentId), {
      participantIds: arrayUnion(currentPlayer.id)
    });
    btn.textContent = "Registered ✓";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-ghost");
    const cached = tournamentsCache?.find((t) => t.id === tournamentId);
    if (cached) {
      cached.participantIds = [...(cached.participantIds || []), currentPlayer.id];
    }
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Register";
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
      const li = document.createElement("li");
      li.className = "lb-row" + (isMe ? " me" : "");
      const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
      li.innerHTML = `
        <span class="lb-rank ${rankClass}">${p.rank}</span>
        <span class="lb-avatar">${(p.name || "?").trim().charAt(0)}</span>
        <span class="lb-mid">
          <div class="lb-name">${p.name || "—"}${isMe ? " (you)" : ""}</div>
          <div class="lb-tier">${meta.displayName}</div>
        </span>
        <span class="lb-points">${Math.round(p.ratingPoints ?? 1000)}</span>
      `;
      listEl.appendChild(li);
    });

    const mine = data.find((p) => p.id === currentPlayer.id);
    $("my-rank-value").textContent = mine ? `#${mine.rank} of ${data.length}` : "—";

    loadingEl.classList.add("hidden");
    listEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the leaderboard.";
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
  const pass = $("login-pass").value;
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in...";

  try {
    const player = await findPlayerByCode(codeRaw);
    if (!player) {
      showMsg(errEl, "That code doesn't exist. Double-check it and try again.");
      return;
    }
    const computedHash = await hashPassword(pass, player.passwordSalt || "");
    if (computedHash !== player.passwordHash) {
      showMsg(errEl, "Wrong password. Try again.");
      return;
    }
    saveSession(player.id);
    renderProfile(player);
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

// ---------------- change password ----------------
$("toggle-change-pass").addEventListener("click", () => {
  $("change-pass-form").classList.toggle("hidden");
});

$("change-pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("pass-error");
  const okEl = $("pass-success");
  hideMsg(errEl);
  hideMsg(okEl);

  const current = $("cp-current").value;
  const next = $("cp-new").value;
  const confirm = $("cp-confirm").value;

  if (next !== confirm) {
    showMsg(errEl, "New password and confirmation don't match.");
    return;
  }
  if (next.length < 6) {
    showMsg(errEl, "New password must be at least 6 characters.");
    return;
  }

  const btn = $("cp-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const computedCurrentHash = await hashPassword(current, currentPlayer.passwordSalt || "");
    if (computedCurrentHash !== currentPlayer.passwordHash) {
      showMsg(errEl, "Current password is wrong.");
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
    showMsg(okEl, "Password changed successfully.");
    $("cp-current").value = "";
    $("cp-new").value = "";
    $("cp-confirm").value = "";
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save new password";
  }
});

// ---------------- logout ----------------
$("logout-btn").addEventListener("click", () => {
  clearSession();
  leaderboardCache = null;
  showLogin();
});

// ---------------- bootstrap: restore session ----------------
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
