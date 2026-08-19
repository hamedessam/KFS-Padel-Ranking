import {
  db, collection, doc, getDoc, getDocs, setDoc,
  query, orderBy, runTransaction, serverTimestamp
} from "./firebase-config.js";
import { hashPassword, randomSalt, generatePassword, playerCodeFromSeq, tierMeta } from "./utils.js";

const $ = (id) => document.getElementById(id);

const viewGate = $("view-gate");
const viewAdmin = $("view-admin");
const gateForm = $("gate-form");
const gateTitle = viewGate.querySelector("h1");
const gateSub = viewGate.querySelector("p.sub");

const ADMIN_SESSION_KEY = "kfs_admin_session";
const ADMIN_CONFIG_REF = doc(db, "config", "admin");
const COUNTERS_REF = doc(db, "config", "counters");

let isSetupMode = false;

function showMsg(el, text) {
  el.textContent = text;
  el.classList.add("show");
}
function hideMsg(el) {
  el.classList.remove("show");
  el.textContent = "";
}

// ---------------- gate ----------------
async function initGate() {
  const snap = await getDoc(ADMIN_CONFIG_REF);
  if (!snap.exists()) {
    isSetupMode = true;
    gateTitle.textContent = "أول مرة؟ اعمل باسورد الأدمن";
    gateSub.textContent = "الباسورد ده هتستخدمه كل مرة تدخل بيها الصفحة دي، احفظه كويس.";
  }

  if (localStorage.getItem(ADMIN_SESSION_KEY) === "ok" && !isSetupMode) {
    enterAdmin();
  }
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("gate-error");
  hideMsg(errEl);
  const pass = $("gate-pass").value;

  try {
    if (isSetupMode) {
      if (pass.length < 6) {
        showMsg(errEl, "الباسورد لازم يكون 6 حروف على الأقل.");
        return;
      }
      const salt = randomSalt();
      const hash = await hashPassword(pass, salt);
      await setDoc(ADMIN_CONFIG_REF, { passwordSalt: salt, passwordHash: hash, createdAt: serverTimestamp() });
      localStorage.setItem(ADMIN_SESSION_KEY, "ok");
      enterAdmin();
      return;
    }

    const snap = await getDoc(ADMIN_CONFIG_REF);
    const data = snap.data();
    const computed = await hashPassword(pass, data.passwordSalt);
    if (computed !== data.passwordHash) {
      showMsg(errEl, "الباسورد غلط.");
      return;
    }
    localStorage.setItem(ADMIN_SESSION_KEY, "ok");
    enterAdmin();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "حصل خطأ، حاول تاني.");
  }
});

function enterAdmin() {
  viewGate.classList.add("hidden");
  viewAdmin.classList.remove("hidden");
  loadPlayers();
}

$("admin-logout").addEventListener("click", () => {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  location.reload();
});

// ---------------- add player ----------------
$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("add-error");
  const okEl = $("add-success");
  hideMsg(errEl);
  hideMsg(okEl);

  const name = $("ap-name").value.trim();
  const phone = $("ap-phone").value.trim();
  const tier = $("ap-tier").value;
  const btn = $("add-btn");

  if (!name || !phone) return;

  btn.disabled = true;
  btn.textContent = "جاري الإضافة...";

  try {
    // atomic counter for sequential player codes: KFS-001, KFS-002, ...
    const seq = await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(COUNTERS_REF);
      const current = counterSnap.exists() ? (counterSnap.data().playerSeq || 0) : 0;
      const next = current + 1;
      tx.set(COUNTERS_REF, { playerSeq: next }, { merge: true });
      return next;
    });

    const playerCode = playerCodeFromSeq(seq);
    const password = generatePassword(8);
    const salt = randomSalt();
    const passwordHash = await hashPassword(password, salt);

    const newPlayerRef = doc(collection(db, "players"));
    await setDoc(newPlayerRef, {
      name,
      phone,
      playerCode,
      passwordSalt: salt,
      passwordHash,
      avatarUrl: "",
      currentTier: tier,
      ratingPoints: 1000,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      isActive: true,
      createdAt: serverTimestamp()
    });

    $("new-code").textContent = playerCode;
    $("new-pass").textContent = password;
    $("credentials-card").classList.remove("hidden");
    $("copy-creds").onclick = () => {
      const msg = `أهلاً ${name}! ده الكود والباسورد بتاعك في تطبيق KFS Padel Ranking:\nالكود: ${playerCode}\nالباسورد: ${password}`;
      navigator.clipboard.writeText(msg);
      $("copy-creds").textContent = "اتنسخت ✓";
      setTimeout(() => { $("copy-creds").textContent = "نسخ الرسالة الجاهزة للواتساب"; }, 1800);
    };

    showMsg(okEl, `تم إضافة ${name} بنجاح.`);
    $("add-form").reset();
    loadPlayers();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "حصل خطأ أثناء الإضافة، حاول تاني.");
  } finally {
    btn.disabled = false;
    btn.textContent = "إضافة اللاعب وتوليد الكود";
  }
});

// ---------------- players list ----------------
async function loadPlayers() {
  const loadingEl = $("players-loading");
  const tableEl = $("players-table");
  const tbody = $("players-tbody");
  loadingEl.classList.remove("hidden");
  tableEl.classList.add("hidden");

  try {
    const q = query(collection(db, "players"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    tbody.innerHTML = "";
    snap.forEach((d) => {
      const p = d.data();
      const meta = tierMeta(p.currentTier);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(p.name || "—")}</td>
        <td class="code">${escapeHtml(p.playerCode || "—")}</td>
        <td><span class="badge-pill ${meta.cssClass}">${meta.displayName}</span></td>
        <td>${Math.round(p.ratingPoints ?? 1000)}</td>
        <td>${p.matchesPlayed ?? 0}</td>
      `;
      tbody.appendChild(tr);
    });
    loadingEl.classList.add("hidden");
    tableEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "حصل خطأ في تحميل اللاعبين.";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

initGate();
