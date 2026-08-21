import { db, collection, doc, getDoc, getDocs, updateDoc, query, where, limit, orderBy } from "./firebase-config.js";
import { hashPassword, randomSalt, tierMeta } from "./utils.js";

const $ = (id) => document.getElementById(id);

const viewLogin = $("view-login");
const viewApp = $("view-app");

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
  $("pf-avatar").textContent = (player.name || "؟").trim().charAt(0);
  $("pf-name").textContent = player.name || "—";
  $("pf-code").textContent = player.playerCode || "—";

  const meta = tierMeta(player.currentTier);
  $("pf-shield").textContent = meta.level || "-";
  $("pf-shield").className = "tier-shield " + meta.cssClass;
  $("pf-tier-name").textContent = meta.displayName;
  $("pf-points").textContent = `${Math.round(player.ratingPoints ?? 1000)} نقطة`;

  $("pf-matches").textContent = player.matchesPlayed ?? 0;
  $("pf-wins").textContent = player.wins ?? 0;
  $("pf-losses").textContent = player.losses ?? 0;

  viewLogin.classList.add("hidden");
  viewApp.classList.remove("hidden");
  switchTab("home");
  loadHome();
}

function showLogin() {
  currentPlayer = null;
  viewApp.classList.add("hidden");
  viewLogin.classList.remove("hidden");
}

// ---------------- tabs ----------------
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  home: $("tab-home"),
  profile: $("tab-profile"),
  leaderboard: $("tab-leaderboard"),
  marketplace: $("tab-marketplace")
};
let leaderboardCache = null; // array of {id, rank, ...data}, shared between Home + Leaderboard tabs

function switchTab(target) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === target));
  Object.entries(tabPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== target);
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    switchTab(target);
    if (target === "leaderboard") loadLeaderboard();
  });
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
  $("home-greeting").textContent = `أهلاً ${(currentPlayer.name || "").split(" ")[0] || ""} 👋`;

  const meta = tierMeta(currentPlayer.currentTier);
  $("hm-shield").textContent = meta.level || "-";
  $("hm-shield").className = "tier-shield " + meta.cssClass;
  $("hm-tier-name").textContent = meta.displayName;
  $("hm-points").textContent = `${Math.round(currentPlayer.ratingPoints ?? 1000)} نقطة`;

  loadAnnouncement();

  try {
    const data = await ensureLeaderboardData();
    const mine = data.find((p) => p.id === currentPlayer.id);
    $("hm-rank-value").textContent = mine ? `#${mine.rank} من ${data.length}` : "—";
  } catch (err) {
    console.error(err);
    $("hm-rank-value").textContent = "—";
  }
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
        <span class="lb-avatar">${(p.name || "؟").trim().charAt(0)}</span>
        <span class="lb-mid">
          <div class="lb-name">${p.name || "—"}${isMe ? " (انت)" : ""}</div>
          <div class="lb-tier">${meta.displayName}</div>
        </span>
        <span class="lb-points">${Math.round(p.ratingPoints ?? 1000)}</span>
      `;
      listEl.appendChild(li);
    });

    const mine = data.find((p) => p.id === currentPlayer.id);
    $("my-rank-value").textContent = mine ? `#${mine.rank} من ${data.length}` : "—";

    loadingEl.classList.add("hidden");
    listEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "حصل خطأ في تحميل الترتيب.";
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
  btn.textContent = "جاري الدخول...";

  try {
    const player = await findPlayerByCode(codeRaw);
    if (!player) {
      showMsg(errEl, "الكود ده مش موجود. اتأكد منه وحاول تاني.");
      return;
    }
    const computedHash = await hashPassword(pass, player.passwordSalt || "");
    if (computedHash !== player.passwordHash) {
      showMsg(errEl, "الباسورد غلط. حاول تاني.");
      return;
    }
    saveSession(player.id);
    renderProfile(player);
  } catch (err) {
    console.error(err);
    showMsg(errEl, "حصل خطأ في الاتصال. حاول تاني.");
  } finally {
    btn.disabled = false;
    btn.textContent = "دخول";
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
    showMsg(errEl, "الباسورد الجديد وتأكيده مش متطابقين.");
    return;
  }
  if (next.length < 6) {
    showMsg(errEl, "الباسورد الجديد لازم يكون 6 حروف أو أرقام على الأقل.");
    return;
  }

  const btn = $("cp-btn");
  btn.disabled = true;
  btn.textContent = "جاري الحفظ...";

  try {
    const computedCurrentHash = await hashPassword(current, currentPlayer.passwordSalt || "");
    if (computedCurrentHash !== currentPlayer.passwordHash) {
      showMsg(errEl, "الباسورد الحالي غلط.");
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
    showMsg(okEl, "تم تغيير الباسورد بنجاح.");
    $("cp-current").value = "";
    $("cp-new").value = "";
    $("cp-confirm").value = "";
  } catch (err) {
    console.error(err);
    showMsg(errEl, "حصل خطأ، حاول تاني.");
  } finally {
    btn.disabled = false;
    btn.textContent = "حفظ الباسورد الجديد";
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
