import { db, collection, doc, getDoc, getDocs, updateDoc, query, where, limit, orderBy, onSnapshot } from "./firebase-config.js";
import { registerPlayer, unregisterPlayer, addPartner, fetchTeams, findTeamOf, requestToJoinTeam, cancelJoinRequest, acceptJoinRequest, declineJoinRequest, getOpenTeams, myPendingRequestTeams, myIncomingRequests } from "./teams.js";
import { hashPassword, randomSalt, tierMeta, tierFromPoints, avatarHtml, isFoundingMember } from "./utils.js";
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
// Alongside the player ID, we also remember the passwordHash that was valid
// at login time. This lets us detect — even after fully closing and
// reopening the app — that the password was changed elsewhere while this
// device was away, and refuse to silently re-authenticate.
function saveSession(playerId, passwordHash) {
  localStorage.setItem("padelx_player_id", playerId);
  localStorage.setItem("padelx_password_hash", passwordHash || "");
}
function clearSession() {
  localStorage.removeItem("padelx_player_id");
  localStorage.removeItem("padelx_password_hash");
}
function getSession() {
  return localStorage.getItem("padelx_player_id");
}
function getSessionPasswordHash() {
  return localStorage.getItem("padelx_password_hash");
}

// ---------------- forced logout (security) ----------------
// Live-watches the current player's own document. If the password changes
// (self-service change, or admin reset) or the account is deleted while
// this tab is open, the session is force-ended immediately — no action
// needed from the person using this device.
let sessionUnsub = null;
let expectedPasswordHash = null;

function startSessionWatch(player) {
  expectedPasswordHash = player.passwordHash;
  stopSessionWatch();
  sessionUnsub = onSnapshot(doc(db, "players", player.id), (snap) => {
    if (!snap.exists()) {
      forceLogout("forced_logout_deleted");
      return;
    }
    const data = snap.data();
    if (data.passwordHash !== expectedPasswordHash) {
      forceLogout("forced_logout_password_changed");
    }
  }, (err) => console.error(err));
}

function stopSessionWatch() {
  if (sessionUnsub) { sessionUnsub(); sessionUnsub = null; }
}

function forceLogout(messageKey) {
  stopSessionWatch();
  clearSession();
  currentPlayer = null;
  leaderboardCache = null;
  tournamentsCache = null;
  showLogin();
  showMsg($("login-error"), t(messageKey));
}

// ---------------- rendering ----------------
// Pure DOM update — safe to call any time (login, avatar change, language switch)
// without touching which view/tab is currently visible.
function refreshProfileDisplay(player) {
  $("pf-avatar").innerHTML = avatarHtml(player);
  $("pf-avatar").classList.toggle("founding-ring", isFoundingMember(player));
  $("pf-name").textContent = player.name || "—";
  $("pf-code").textContent = player.playerCode || "—";

  const meta = tierMeta(tierFromPoints(player.ratingPoints));
  $("pf-shield").textContent = meta.level || "-";
  $("pf-shield").className = "tier-shield " + meta.cssClass;
  $("pf-shield").classList.toggle("hidden", !tiersEnabled);
  $("pf-tier-name").textContent = tierLabelOrHidden(meta);
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
  startSessionWatch(player);

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

  el.innerHTML += `<span class="badge-pill gold">🪙 ${Math.round(player.coinsBalance ?? 0)} ${t("coins_label")}</span>`;
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

// ---------------- tournaments sub-tabs (list / requests) ----------------
// Scoped to #tab-tournaments only — otherwise this generic .subtab-btn
// selector would also catch the new Profile/History subtabs below and cause
// cross-talk between the two independent subtab groups.
document.querySelectorAll("#tab-tournaments .subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tab-tournaments .subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("tournaments-subtab-list").classList.toggle("hidden", btn.dataset.subtab !== "list");
    $("tournaments-subtab-requests").classList.toggle("hidden", btn.dataset.subtab !== "requests");
    if (btn.dataset.subtab === "requests") loadRequestsSubtab();
    // Refresh the tournaments list (and its registered-players counts) whenever
    // coming back from Requests — e.g. right after accepting/declining a
    // request, so the count reflects reality without needing a full page reload.
    if (btn.dataset.subtab === "list") loadTournamentsTab();
  });
});

// ---------------- profile sub-tabs (Profile / History) ----------------
document.querySelectorAll("#profile-main-subtab-bar .subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#profile-main-subtab-bar .subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("profile-subtab-main").classList.toggle("hidden", btn.dataset.profileSubtab !== "main");
    $("profile-subtab-history").classList.toggle("hidden", btn.dataset.profileSubtab !== "history");
    if (btn.dataset.profileSubtab === "history") {
      const activeInner = $("history-inner-subtab-bar").querySelector(".subtab-btn.active");
      if (!activeInner || activeInner.dataset.historySubtab === "points") loadPointsHistory();
      else loadCoinsHistoryTab();
    }
  });
});

// ---------------- history sub-tabs (Points / Coins) ----------------
document.querySelectorAll("#history-inner-subtab-bar .subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#history-inner-subtab-bar .subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("history-subtab-points").classList.toggle("hidden", btn.dataset.historySubtab !== "points");
    $("history-subtab-coins").classList.toggle("hidden", btn.dataset.historySubtab !== "coins");
    if (btn.dataset.historySubtab === "points") loadPointsHistory();
    else loadCoinsHistoryTab();
  });
});

async function loadRequestsSubtab() {
  const loadingEl = $("requests-loading");
  const listEl = $("requests-list");
  const emptyEl = $("requests-empty");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  try {
    const tournaments = await ensureTournamentsData();
    const relevant = tournaments.filter((tr) => tr.status !== "completed");

    const incomingByTournament = await Promise.all(
      relevant.map(async (tr) => {
        const teams = await fetchTeams(tr.id);
        return myIncomingRequests(teams, currentPlayer.id).map((team) => ({ tournamentId: tr.id, team }));
      })
    );
    const allIncoming = incomingByTournament.flat();

    loadingEl.classList.add("hidden");

    const totalRequests = allIncoming.reduce((sum, x) => sum + (x.team.joinRequests || []).length, 0);
    const badge = $("requests-badge");
    if (totalRequests > 0) {
      badge.textContent = totalRequests;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }

    if (allIncoming.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }

    listEl.innerHTML = "";
    for (const { tournamentId, team } of allIncoming) {
      for (const requesterId of team.joinRequests || []) {
        const card = await buildRequestCard(tournamentId, team, requesterId);
        listEl.appendChild(card);
      }
    }
    listEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

async function buildRequestCard(tournamentId, team, requesterId) {
  const pDoc = await getDoc(doc(db, "players", requesterId));
  const p = pDoc.exists() ? { id: requesterId, ...pDoc.data() } : { id: requesterId, name: "—" };

  const matches = p.matchesPlayed ?? 0;
  const wins = p.wins ?? 0;
  const winRate = matches > 0 ? `${Math.round((wins / matches) * 100)}%` : "—";
  const meta = tierMeta(tierFromPoints(p.ratingPoints));

  const card = document.createElement("div");
  card.className = "request-card";
  card.innerHTML = `
    <div class="request-card-head" data-toggle-stats>
      <div class="avatar" style="width:44px;height:44px;font-size:16px;">${avatarHtml(p)}</div>
      <div>
        <div class="request-card-name">${p.name || "—"}</div>
        <div class="request-card-sub">#${team.teamNumber} · ${t("wants_to_join_your_team")}${tiersEnabled ? ` · ${meta.displayName}` : ""}</div>
      </div>
    </div>
    <div class="request-card-stats">
      <div class="stat-box"><div class="num">${Math.round(p.ratingPoints ?? 1000)}</div><div class="lbl">${t("pts")}</div></div>
      <div class="stat-box"><div class="num">${matches}</div><div class="lbl">${t("profile_matches")}</div></div>
      <div class="stat-box"><div class="num">${winRate}</div><div class="lbl">${t("profile_winrate")}</div></div>
    </div>
    <div class="request-card-actions">
      <button class="btn btn-primary btn-sm" data-accept type="button">${t("accept_btn")}</button>
      <button class="btn btn-ghost btn-sm" data-decline type="button">${t("decline_btn")}</button>
    </div>
  `;

  card.querySelector("[data-toggle-stats]").addEventListener("click", () => {
    card.querySelector(".request-card-stats").classList.toggle("show");
  });
  card.querySelector("[data-accept]").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = t("accepting");
    try {
      await acceptJoinRequest(tournamentId, team.id, requesterId);
      leaderboardCache = null; // roster changed
      loadRequestsSubtab();
    } catch (err) {
      console.error(err);
      e.target.disabled = false;
      e.target.textContent = t("accept_btn");
    }
  });
  card.querySelector("[data-decline]").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = t("declining");
    try {
      await declineJoinRequest(tournamentId, team.id, requesterId);
      loadRequestsSubtab();
    } catch (err) {
      console.error(err);
      e.target.disabled = false;
      e.target.textContent = t("decline_btn");
    }
  });

  return card;
}

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

  const meta = tierMeta(tierFromPoints(currentPlayer.ratingPoints));
  $("hm-shield").textContent = meta.level || "-";
  $("hm-shield").className = "tier-shield " + meta.cssClass;
  $("hm-shield").classList.toggle("hidden", !tiersEnabled);
  $("hm-tier-name").textContent = tierLabelOrHidden(meta);
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
    const meta = tierMeta(tierFromPoints(p.ratingPoints));
    const founding = isFoundingMember(p);
    const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
    const row = document.createElement("div");
    row.className = "lb-row" + (isMe ? " me" : "");
    row.innerHTML = `
      <span class="lb-rank ${rankClass}">${p.rank}</span>
      <span class="lb-avatar${founding ? " founding-ring" : ""}">${avatarHtml(p)}</span>
      <span class="lb-mid">
        <div class="lb-name">${founding ? '<span class="founding-star" title="Founding Member">🌟</span> ' : ""}${p.name || "—"}${isMe ? " " + t("you_suffix") : ""}</div>
        <div class="lb-tier">${tierLabelOrHidden(meta)}</div>
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
      const deadline = tr.registrationDeadline?.toDate ? tr.registrationDeadline.toDate() : null;
      const isPastDeadline = deadline ? deadline.getTime() < Date.now() : false;

      let actionHtml = "";
      if (tr.status === "upcoming") {
        if (isRegistered) {
          actionHtml = isPastDeadline
            ? `<button class="btn btn-ghost btn-sm" disabled>${t("registered_btn")}</button>`
            : `<button class="btn btn-ghost btn-sm" data-unregister="${tr.id}">${t("unregister_btn")}</button>`;
        } else if (isPastDeadline) {
          actionHtml = `<span class="hint">${t("registration_closed")}</span>`;
        } else {
          actionHtml = `<span class="spinner"></span>`; // resolved async right after render
        }
      }
      const viewParticipantsHtml = `<button class="btn btn-ghost btn-sm" data-view-participants="${tr.id}" type="button">${t("view_players_btn")} (${(tr.participantIds || []).length})</button>`;

      row.innerHTML = `
        <div class="tourney-row-top">
          <div>
            <span class="tourney-status ${tr.status || "upcoming"}">${tr.status === "live" ? '<span class="dot-live"></span>' : ""}${statusLabel(tr.status)}</span>
            <div class="tourney-name">${tr.name || "—"}</div>
          </div>
        </div>
        ${tr.location ? `<div class="tourney-meta">${PIN_SVG}${tr.location}</div>` : ""}
        ${tr.dateLabel ? `<div class="tourney-meta">${CAL_SVG}${tr.dateLabel}</div>` : ""}
        ${deadline ? `<div class="tourney-meta">${CAL_SVG}${t("deadline_label")}: ${deadline.toLocaleString(getLang() === "ar" ? "ar-EG" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
        ${tr.championName ? `<div class="tourney-champion">🏆 ${t("champion_label")}: ${tr.championName}</div>` : ""}
        <div class="tourney-actions">
          ${viewParticipantsHtml}
          <span id="actions-${tr.id}" style="display:contents;">${actionHtml}</span>
        </div>
        ${isPastDeadline && isRegistered ? `<div class="hint" style="margin-top:6px;">${t("registration_locked_hint")}</div>` : ""}
        <div class="tourney-participants hidden" id="participants-${tr.id}"></div>
      `;
      listEl.appendChild(row);
    });
    listEl.classList.remove("hidden");

    listEl.querySelectorAll("[data-unregister]").forEach((btn) => {
      btn.addEventListener("click", () => unregisterFromTournament(btn.dataset.unregister, btn));
    });
    listEl.querySelectorAll("[data-view-participants]").forEach((btn) => {
      btn.addEventListener("click", () => toggleTeamGridView(btn.dataset.viewParticipants));
    });

    // resolve the register/join/pending state for each open, unregistered tournament
    data.forEach((tr) => {
      const isRegistered = (tr.participantIds || []).includes(currentPlayer.id);
      const deadline = tr.registrationDeadline?.toDate ? tr.registrationDeadline.toDate() : null;
      const isPastDeadline = deadline ? deadline.getTime() < Date.now() : false;
      if (tr.status === "upcoming" && !isRegistered && !isPastDeadline) {
        resolveRegisterActions(tr.id);
      }
    });

    loadRequestsSubtab(); // keeps the "Requests" badge fresh in the background
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

// ---------------- register / join-a-team / pending-request states ----------------
async function resolveRegisterActions(tournamentId) {
  const el = $(`actions-${tournamentId}`);
  if (!el) return;

  try {
    const [teams, tSnap] = await Promise.all([
      fetchTeams(tournamentId),
      getDoc(doc(db, "tournaments", tournamentId))
    ]);

    const waitingList = tSnap.exists() ? (tSnap.data().waitingList || []) : [];
    const myWaitPos = waitingList.indexOf(currentPlayer.id);

    if (myWaitPos !== -1) {
      el.innerHTML = `
        <button class="btn btn-ghost btn-sm" disabled>${t("waiting_list_label")} #${myWaitPos + 1}</button>
        <button class="link-btn" data-leave-waitlist type="button" style="font-size:12px;">${t("leave_waitlist_btn")}</button>
      `;
      el.querySelector("[data-leave-waitlist]").addEventListener("click", (e) => unregisterFromTournament(tournamentId, e.target));
      return;
    }

    const pending = myPendingRequestTeams(teams, currentPlayer.id);

    if (pending.length > 0) {
      el.innerHTML = `
        <button class="btn btn-ghost btn-sm" disabled>${t("request_sent_label")}</button>
        <button class="link-btn" data-cancel-request type="button" style="font-size:12px;">${t("cancel_request_btn")}</button>
      `;
      el.querySelector("[data-cancel-request]").addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await cancelJoinRequest(tournamentId, pending[0].id, currentPlayer.id);
          resolveRegisterActions(tournamentId);
        } catch (err) {
          console.error(err);
          e.target.disabled = false;
        }
      });
      return;
    }

    // No existing interaction yet (not on waiting list, no pending request) —
    // hold off on showing Register/Join until the player has checked
    // "View registered players" first, per explicit request: view before choosing.
    el.innerHTML = "";
    el.dataset.pendingView = "true";
  } catch (err) {
    console.error(err);
  }
}

// Reveals the Register/Join buttons after the player has viewed the team list.
// No-op if this tournament's actions were already resolved to something else
// (registered, past deadline, pending request, or waiting list — none of
// those should ever be gated behind viewing the list).
async function revealRegisterJoinOptions(tournamentId) {
  const el = $(`actions-${tournamentId}`);
  if (!el || el.dataset.pendingView !== "true") return;
  try {
    const teams = await fetchTeams(tournamentId);
    el.innerHTML = `
      <button class="btn btn-primary btn-sm" data-register type="button">${t("register_own_team_btn")}</button>
      <button class="btn btn-ghost btn-sm" data-join type="button">${t("join_team_btn")}</button>
    `;
    el.querySelector("[data-register]").addEventListener("click", (e) => registerForTournament(tournamentId, e.target));
    el.querySelector("[data-join]").addEventListener("click", () => toggleJoinTeamPicker(tournamentId, teams));
    el.dataset.pendingView = "false";
  } catch (err) {
    console.error(err);
  }
}

function toggleJoinTeamPicker(tournamentId, teams) {
  const containerId = `jointeams-${tournamentId}`;
  const existing = document.getElementById(containerId);
  if (existing) {
    existing.remove();
    return;
  }

  const actionsEl = $(`actions-${tournamentId}`);
  const div = document.createElement("div");
  div.id = containerId;
  div.style.marginTop = "12px";

  const openTeams = getOpenTeams(teams).filter((tm) => tm.player1Id !== currentPlayer.id && tm.player2Id !== currentPlayer.id);

  if (openTeams.length === 0) {
    div.innerHTML = `<div class="hint">${t("no_open_teams")}</div>`;
  } else {
    div.innerHTML = `
      <div class="section-head" style="margin:0 0 8px;"><h2 style="font-size:13px;">${t("open_teams_title")}</h2></div>
      ${openTeams.map((tm) => `
        <div class="open-team-row" data-team-row="${tm.id}">
          <span data-team-name="${tm.id}">…</span>
          <button class="btn btn-primary btn-sm" data-send-request="${tm.id}" type="button">${t("send_request_btn")}</button>
        </div>
      `).join("")}
    `;
  }

  actionsEl.insertAdjacentElement("afterend", div);

  openTeams.forEach(async (tm) => {
    const existingId = tm.player1Id || tm.player2Id;
    try {
      const pDoc = await getDoc(doc(db, "players", existingId));
      const nameEl = div.querySelector(`[data-team-name="${tm.id}"]`);
      if (nameEl && pDoc.exists()) nameEl.textContent = `#${tm.teamNumber} — ${pDoc.data().name || "—"}`;
    } catch (err) {
      console.error(err);
    }
  });

  div.querySelectorAll("[data-send-request]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = t("sending_request");
      try {
        await requestToJoinTeam(tournamentId, btn.dataset.sendRequest, currentPlayer.id);
        div.remove();
        resolveRegisterActions(tournamentId);
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = t("send_request_btn");
      }
    });
  });
}

async function registerForTournament(tournamentId, btn) {
  btn.disabled = true;
  btn.textContent = t("registering");
  try {
    const tr = tournamentsCache?.find((x) => x.id === tournamentId);
    await registerPlayer(tournamentId, currentPlayer.id, tr?.totalTeams || 12);
    if (tr) tr.participantIds = [...(tr.participantIds || []), currentPlayer.id];
    loadTournamentsTab();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = t("register_own_team_btn");
  }
}

async function unregisterFromTournament(tournamentId, btn) {
  try {
    const teams = await fetchTeams(tournamentId);
    const myTeam = findTeamOf(teams, currentPlayer.id);

    // founder with a partner: ambiguous, needs an explicit choice instead of a plain confirm
    if (myTeam && myTeam.player1Id === currentPlayer.id && myTeam.player2Id) {
      showFounderLeaveChoice(tournamentId, myTeam, btn);
      return;
    }

    if (!confirm(t("unregister_confirm"))) return;
    await performUnregister(tournamentId, btn);
  } catch (err) {
    console.error(err);
  }
}

async function performUnregister(tournamentId, btn, founderChoice) {
  btn.disabled = true;
  btn.textContent = t("unregistering");
  try {
    await unregisterPlayer(tournamentId, currentPlayer.id, founderChoice);
    const cached = tournamentsCache?.find((tr) => tr.id === tournamentId);
    if (cached) cached.participantIds = (cached.participantIds || []).filter((id) => id !== currentPlayer.id);
    loadTournamentsTab();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = t("unregister_btn");
  }
}

async function showFounderLeaveChoice(tournamentId, myTeam, btn) {
  const containerId = `founder-choice-${tournamentId}`;
  if (document.getElementById(containerId)) return; // already open

  let partnerName = "—";
  try {
    const pDoc = await getDoc(doc(db, "players", myTeam.player2Id));
    if (pDoc.exists()) partnerName = pDoc.data().name || "—";
  } catch (err) {
    console.error(err);
  }

  const div = document.createElement("div");
  div.id = containerId;
  div.style.marginTop = "10px";
  div.innerHTML = `
    <div class="hint" style="margin-bottom:8px;">${t("founder_leave_prompt").replace("{name}", partnerName)}</div>
    <div style="display:flex; flex-direction:column; gap:8px;">
      <button class="btn btn-ghost btn-sm" data-choice="promote-partner" type="button">${t("leave_to_partner_btn").replace("{name}", partnerName)}</button>
      <button class="btn btn-ghost btn-sm" data-choice="fill-from-waitlist" type="button">${t("fill_from_waitlist_btn")}</button>
      <button class="link-btn" data-choice="cancel" type="button" style="font-size:12px;">${t("cancel_btn")}</button>
    </div>
  `;
  btn.insertAdjacentElement("afterend", div);

  div.querySelectorAll("[data-choice]").forEach((choiceBtn) => {
    choiceBtn.addEventListener("click", () => {
      const choice = choiceBtn.dataset.choice;
      div.remove();
      if (choice === "cancel") return;
      performUnregister(tournamentId, btn, choice);
    });
  });
}

// ---------------- full team grid (read-only for everyone, except your own open slot) ----------------
async function toggleTeamGridView(tournamentId) {
  const container = $(`participants-${tournamentId}`);
  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  await renderTeamGrid(tournamentId, container);
  revealRegisterJoinOptions(tournamentId);
}

async function renderTeamGrid(tournamentId, container) {
  container.innerHTML = `<span class="spinner"></span> ${t("loading")}`;

  try {
    const tr = tournamentsCache?.find((x) => x.id === tournamentId);
    const totalTeams = tr?.totalTeams || 12;
    const teams = await fetchTeams(tournamentId);

    const assignedIds = new Set();
    teams.forEach((tm) => { if (tm.player1Id) assignedIds.add(tm.player1Id); if (tm.player2Id) assignedIds.add(tm.player2Id); });

    // resolve names for everyone currently on a team
    const playerDocs = await Promise.all([...assignedIds].map((id) => getDoc(doc(db, "players", id))));
    const nameById = new Map();
    playerDocs.forEach((d) => {
      if (d.exists()) {
        const pd = d.data();
        nameById.set(d.id, `${pd.name || "—"} (${pd.playerCode || "—"})`);
      }
    });

    // candidates for the partner picker: active players not on any team here yet
    const allActiveSnap = await getDocs(query(collection(db, "players"), orderBy("name")));
    const candidates = allActiveSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.isActive !== false && !assignedIds.has(p.id) && p.id !== currentPlayer.id);
    const candidateOptions = candidates.map((p) => `<option value="${p.id}">${p.name} (${p.playerCode})</option>`).join("");

    const teamByNumber = new Map(teams.map((tm) => [tm.teamNumber, tm]));

    let html = "";

    for (let n = 1; n <= totalTeams; n++) {
      const team = teamByNumber.get(n);
      const cellHtml = (playerId, otherId) => {
        if (playerId) {
          return `<div class="team-slot-player"><span class="team-slot-player-name">${nameById.get(playerId) || "—"}</span></div>`;
        }
        const isMyOpenSlot = team && otherId === currentPlayer.id;
        if (isMyOpenSlot) {
          return `
            <div class="team-slot-player my-team-picker">
              <select class="team-slot-add-select" id="grid-partner-select-${tournamentId}-${n}">
                <option value="">${t("choose_partner_placeholder")}</option>
                ${candidateOptions}
              </select>
              <button class="btn btn-ghost btn-sm" data-add-partner-grid="${team.id}" data-select-id="grid-partner-select-${tournamentId}-${n}" data-tournament="${tournamentId}" type="button">${t("add_partner_btn")}</button>
            </div>`;
        }
        return `<div class="team-slot-player"><span class="team-slot-player-name" style="opacity:.4;">—</span></div>`;
      };

      html += `
        <div class="team-slot-row">
          <div class="team-slot-row-head">
            <span class="team-slot-number">${t("team_label")} ${n}</span>
            <span class="team-slot-group-tag">${team?.group ? `${t("group_label")} ${team.group}` : "—"}</span>
          </div>
          <div class="team-slot-players">
            ${cellHtml(team?.player1Id, team?.player2Id)}
            ${cellHtml(team?.player2Id, team?.player1Id)}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll("[data-add-partner-grid]").forEach((addBtn) => {
      addBtn.addEventListener("click", async () => {
        const select = $(addBtn.dataset.selectId);
        const chosenId = select.value;
        if (!chosenId) return;
        addBtn.disabled = true;
        addBtn.textContent = t("registering");
        try {
          await addPartner(addBtn.dataset.tournament, addBtn.dataset.addPartnerGrid, chosenId);
          renderTeamGrid(tournamentId, container);
        } catch (err) {
          console.error(err);
          addBtn.disabled = false;
          addBtn.textContent = t("add_partner_btn");
        }
      });
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = t("leaderboard_err");
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
      const meta = tierMeta(tierFromPoints(p.ratingPoints));
      const founding = isFoundingMember(p);
      const li = document.createElement("li");
      li.className = "lb-row" + (isMe ? " me" : "");
      const rankClass = p.rank === 1 ? "top1" : p.rank === 2 ? "top2" : p.rank === 3 ? "top3" : "";
      li.innerHTML = `
        <span class="lb-rank ${rankClass}">${p.rank}</span>
        <span class="lb-avatar${founding ? " founding-ring" : ""}">${avatarHtml(p)}</span>
        <span class="lb-mid">
          <div class="lb-name">${founding ? '<span class="founding-star" title="Founding Member">🌟</span> ' : ""}${p.name || "—"}${isMe ? " " + t("you_suffix") : ""}</div>
          <div class="lb-tier">${tierLabelOrHidden(meta)}</div>
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

// ---------------- profile: points history (read-only — reads the existing ratingHistory audit trail) ----------------
async function loadPointsHistory() {
  const loadingEl = $("ph-loading");
  const listEl = $("ph-list");
  const emptyEl = $("ph-empty");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  $("ph-total").textContent = `${Math.round(currentPlayer.ratingPoints ?? 1000)} ${t("pts")}`;

  try {
    const snap = await getDocs(query(collection(db, "ratingHistory"), where("playerId", "==", currentPlayer.id)));
    const entries = snap.docs.map((d) => d.data()).sort((a, b) => {
      const at = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
      const bt = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
      return bt - at; // newest first
    });

    loadingEl.classList.add("hidden");

    if (entries.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }

    // Batch-fetch everything needed to describe each match: the match doc
    // (opponent IDs, round, scores), the tournament doc (name), and the
    // opponents' names — all in a handful of parallel reads, not per-row.
    const matchIds = [...new Set(entries.map((e) => e.matchId).filter(Boolean))];
    const matchDocs = await Promise.all(matchIds.map((id) => getDoc(doc(db, "matches", id))));
    const matchById = new Map();
    matchDocs.forEach((d) => { if (d.exists()) matchById.set(d.id, d.data()); });

    const tournamentIds = [...new Set(entries.map((e) => e.tournamentId).filter(Boolean))];
    const tournamentDocs = await Promise.all(tournamentIds.map((id) => getDoc(doc(db, "tournaments", id))));
    const tournamentById = new Map();
    tournamentDocs.forEach((d) => { if (d.exists()) tournamentById.set(d.id, d.data()); });

    const opponentIds = new Set();
    entries.forEach((e) => {
      const m = matchById.get(e.matchId);
      if (!m) return;
      const onTeam1 = (m.team1 || []).includes(currentPlayer.id);
      ((onTeam1 ? m.team2 : m.team1) || []).forEach((id) => opponentIds.add(id));
    });
    const opponentDocs = await Promise.all([...opponentIds].map((id) => getDoc(doc(db, "players", id))));
    const opponentNameById = new Map();
    opponentDocs.forEach((d) => { if (d.exists()) opponentNameById.set(d.id, d.data().name || "—"); });

    listEl.innerHTML = entries.map((e) => {
      const m = matchById.get(e.matchId);
      const tr = tournamentById.get(e.tournamentId);
      const won = e.actualResult === 1;
      const sign = e.pointsChange >= 0 ? "+" : "";
      const color = e.pointsChange >= 0 ? "var(--live)" : "var(--danger)";

      let scoreLabel = "—";
      let opponentsLabel = "—";
      if (m) {
        const onTeam1 = (m.team1 || []).includes(currentPlayer.id);
        const myScore = onTeam1 ? m.team1Games : m.team2Games;
        const oppScore = onTeam1 ? m.team2Games : m.team1Games;
        scoreLabel = `${myScore}-${oppScore}`;
        opponentsLabel = ((onTeam1 ? m.team2 : m.team1) || []).map((id) => opponentNameById.get(id) || "—").join(" & ");
      }

      const resultText = (won ? t("points_won_against") : t("points_lost_against"))
        .replace("{score}", scoreLabel)
        .replace("{opponents}", opponentsLabel);

      const metaParts = [];
      if (tr?.name) metaParts.push(tr.name);
      if (m?.round) metaParts.push(m.round);
      const date = e.createdAt?.toDate
        ? e.createdAt.toDate().toLocaleDateString(getLang() === "ar" ? "ar-EG" : "en-US", { month: "short", day: "numeric" })
        : "";
      if (date) metaParts.push(date);

      return `
        <div style="padding:10px 0; border-bottom:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
            <span style="font-size:13px; color:var(--text);">${resultText}</span>
            <span style="color:${color}; font-family:var(--font-mono); font-weight:700; font-size:13px; flex-shrink:0;">${sign}${e.pointsChange.toFixed(1)}</span>
          </div>
          <div style="font-size:11px; color:var(--text-soft); margin-top:3px;">${metaParts.join(" · ")}</div>
        </div>
      `;
    }).join("");
    listEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = t("leaderboard_err");
  }
}

// ---------------- profile: coins history (read-only — reads the existing coinTransactions audit trail) ----------------
function coinTxLabel(tx) {
  if (tx.type === "placement" && tx.position) return t(`coin_type_placement_${tx.position}`);
  if (tx.type === "participation") return t("coin_type_participation");
  if (tx.type === "advancement") return t("coin_type_advancement");
  return tx.note || tx.type || "—"; // fallback for any future/manual transaction type
}

async function loadCoinsHistoryTab() {
  const loadingEl = $("ch-loading");
  const listEl = $("ch-list");
  const emptyEl = $("ch-empty");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  $("ch-total").textContent = `${Math.round(currentPlayer.coinsBalance ?? 0)} ${t("coins_label")}`;

  try {
    const snap = await getDocs(query(collection(db, "coinTransactions"), where("playerId", "==", currentPlayer.id)));
    const transactions = snap.docs.map((d) => d.data()).sort((a, b) => {
      const at = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
      const bt = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
      return bt - at; // newest first
    });

    loadingEl.classList.add("hidden");

    if (transactions.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }

    listEl.innerHTML = transactions.map((tx) => {
      const sign = tx.amount >= 0 ? "+" : "";
      const color = tx.amount >= 0 ? "var(--live)" : "var(--danger)";
      const date = tx.createdAt?.toDate
        ? tx.createdAt.toDate().toLocaleDateString(getLang() === "ar" ? "ar-EG" : "en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border);">
          <div>
            <div style="font-size:13px; color:var(--text);">${coinTxLabel(tx)}</div>
            <div style="font-size:11px; color:var(--text-soft); margin-top:2px;">${date}</div>
          </div>
          <span style="color:${color}; font-family:var(--font-mono); font-weight:700; font-size:13px;">${sign}${tx.amount}</span>
        </div>
      `;
    }).join("");
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
    saveSession(player.id, player.passwordHash);
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
    expectedPasswordHash = newHash;
    saveSession(currentPlayer.id, newHash);
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
    ctx.fillText("PADEL X", W / 2 + 30, 106);

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

    // tier pill (or plain points pill while tiers are hidden)
    const meta = tierMeta(tierFromPoints(currentPlayer.ratingPoints));
    const tierColors = { gold: "#e3b74e", silver: "#b9c2c8", bronze: "#b98a5a" };
    const pillY = avatarY + avatarSize + 200;
    ctx.font = "800 34px 'Cairo', sans-serif";
    const pillText = tierLabelOrHidden(meta);
    const pillWidth = ctx.measureText(pillText).width + 80;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, W / 2 - pillWidth / 2, pillY - 44, pillWidth, 76, 38);
    ctx.fill();
    ctx.fillStyle = tiersEnabled ? (tierColors[meta.cssClass] || "#c9f24c") : "#c9f24c";
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
    ctx.fillText("padelx.me", W / 2, H - 60);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
    const fileName = `padel-x-${(currentPlayer.playerCode || "profile").toLowerCase()}.png`;
    const file = new File([blob], fileName, { type: "image/png" });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Padel X" });
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
  stopSessionWatch();
  clearSession();
  leaderboardCache = null;
  tournamentsCache = null;
  showLogin();
});

// ---------------- app settings (tiers on/off, admin-controlled) ----------------
let tiersEnabled = false; // default off until admin explicitly turns tiers on

async function loadAppSettings() {
  try {
    const snap = await getDoc(doc(db, "config", "appSettings"));
    tiersEnabled = snap.exists() ? !!snap.data().tiersEnabled : false;
  } catch (err) {
    console.error(err);
    tiersEnabled = false;
  }
}

function tierLabelOrHidden(meta) {
  return tiersEnabled ? meta.displayName : t("tier_hidden_label");
}

// ---------------- bootstrap ----------------
applyStaticTranslations();

(async function init() {
  await loadAppSettings();
  const savedId = getSession();
  if (!savedId) return;
  try {
    const player = await loadPlayerById(savedId);
    if (!player) {
      clearSession();
      return;
    }
    const savedHash = getSessionPasswordHash();
    if (!savedHash) {
      // Session predates this security check — trust it now and start
      // tracking from this point forward (avoids logging out everyone
      // who was already signed in before this feature shipped).
      saveSession(player.id, player.passwordHash);
    } else if (player.passwordHash !== savedHash) {
      // Password was changed (or reset by the admin) while this device
      // was closed — refuse to silently re-authenticate.
      clearSession();
      showMsg($("login-error"), t("forced_logout_password_changed"));
      return;
    }
    renderProfile(player);
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
