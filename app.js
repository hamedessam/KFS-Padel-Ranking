import { db, collection, doc, getDoc, getDocs, updateDoc, query, where, limit } from "./firebase-config.js";
import { hashPassword, randomSalt, tierMeta } from "./utils.js";

const $ = (id) => document.getElementById(id);

const viewLogin = $("view-login");
const viewProfile = $("view-profile");

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
  viewProfile.classList.remove("hidden");
}

function showLogin() {
  currentPlayer = null;
  viewProfile.classList.add("hidden");
  viewLogin.classList.remove("hidden");
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
