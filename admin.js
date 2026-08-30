import {
  db, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, orderBy, where, runTransaction, writeBatch, increment, arrayUnion, serverTimestamp
} from "./firebase-config.js";
import { hashPassword, randomSalt, generatePassword, playerCodeFromSeq, tierMeta, tierFromPoints, isFoundingMember, computeMatchPointChanges } from "./utils.js";
import { fetchTeams, assignToSlot, unregisterPlayer, setTeamGroup } from "./teams.js";

const $ = (id) => document.getElementById(id);

const viewGate = $("view-gate");
const viewAdmin = $("view-admin");
const gateForm = $("gate-form");
const gateTitle = viewGate.querySelector("h1");
const gateSub = viewGate.querySelector("p.sub");

const ADMIN_SESSION_KEY = "padelx_admin_session";
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
    gateTitle.textContent = "First time? Set the admin password";
    gateSub.textContent = "You'll use this password every time you open this page — keep it safe.";
  }

  if (localStorage.getItem(ADMIN_SESSION_KEY) === "ok" && !isSetupMode) {
    enterAdmin();
  }
}

gateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("gate-error");
  hideMsg(errEl);
  const pass = $("gate-pass").value.trim();

  try {
    if (isSetupMode) {
      if (pass.length < 6) {
        showMsg(errEl, "Password must be at least 6 characters.");
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
      showMsg(errEl, "Wrong password.");
      return;
    }
    localStorage.setItem(ADMIN_SESSION_KEY, "ok");
    enterAdmin();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong. Try again.");
  }
});

function enterAdmin() {
  viewGate.classList.add("hidden");
  viewAdmin.classList.remove("hidden");
  loadPlayers();
  loadAnnouncementForm();
  loadTournaments();
  loadTiersToggle();
  loadMatchFormOptions();
  loadTMTournamentSelect();
  initCoinParticipationTab();
  initCoinAdvancementTab();
  initCoinPlacementTab();
  initCoinLogTab();
}

// ---------------- admin tab switcher ----------------
document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".admin-tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `admin-tab-${btn.dataset.adminTab}`);
    });
  });
});

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
  const startingPoints = parseInt($("ap-points").value, 10) || 1000;
  const btn = $("add-btn");

  if (!name || !phone) return;

  btn.disabled = true;
  btn.textContent = "Adding...";

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
      ratingPoints: startingPoints,
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
      const msg = `Hey ${name}! Here are your login details for Padel X:\nCode: ${playerCode}\nPassword: ${password}`;
      navigator.clipboard.writeText(msg);
      $("copy-creds").textContent = "Copied ✓";
      setTimeout(() => { $("copy-creds").textContent = "Copy WhatsApp-ready message"; }, 1800);
    };

    showMsg(okEl, `${name} added successfully. Assign them to a team in the Tournament Manager tab whenever you're ready.`);
    $("add-form").reset();
    loadPlayers();
    loadMatchFormOptions();
    initCoinLogTab();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong while adding the player. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add player & generate code";
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
      const meta = tierMeta(tierFromPoints(p.ratingPoints));
      const tr = document.createElement("tr");
      const avatarCell = p.avatarUrl
        ? `<img src="${p.avatarUrl}" alt="" style="width:28px;height:28px;border-radius:50%;object-fit:cover;display:block;">`
        : `<div style="width:28px;height:28px;border-radius:50%;background:var(--panel-alt);color:var(--ball);display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-weight:800;font-size:11px;">${(p.name || "?").trim().charAt(0)}</div>`;
      tr.innerHTML = `
        <td>${avatarCell}</td>
        <td>${isFoundingMember(p) ? "🌟 " : ""}${escapeHtml(p.name || "—")}</td>
        <td class="code">${escapeHtml(p.playerCode || "—")}</td>
        <td><span class="badge-pill ${meta.cssClass}">${meta.displayName}</span></td>
        <td>${Math.round(p.ratingPoints ?? 1000)}</td>
        <td>${p.matchesPlayed ?? 0}</td>
        <td style="white-space:nowrap;">
          <button class="link-btn" data-reset-player="${d.id}" data-player-name="${escapeHtml(p.name || "—")}" type="button" style="font-size:12px;">Reset password</button>
          <button class="link-btn" data-delete-player="${d.id}" data-player-name="${escapeHtml(p.name || "—")}" type="button" style="font-size:12px; color:var(--danger);">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    loadingEl.classList.add("hidden");
    tableEl.classList.remove("hidden");

    tbody.querySelectorAll("[data-reset-player]").forEach((btn) => {
      btn.addEventListener("click", () => resetPlayerPassword(btn.dataset.resetPlayer, btn.dataset.playerName, btn));
    });
    tbody.querySelectorAll("[data-delete-player]").forEach((btn) => {
      btn.addEventListener("click", () => deletePlayerCompletely(btn.dataset.deletePlayer, btn.dataset.playerName, btn));
    });
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the players.";
  }
}

// ---------------- permanently delete a player ----------------
// Hard delete: removes their profile and login entirely — they can never sign
// in again with that code. Not reversible. Their name may still appear in old
// match/rating history records (those aren't touched), but the account itself
// is gone. Also pulls them out of any tournament team slots first.
async function deletePlayerCompletely(playerId, playerName, btn) {
  const confirmed = confirm(
    `Permanently delete ${playerName}?\n\nThis removes their profile and login completely — their code and password will stop working immediately, and this CANNOT be undone.\n\nAre you sure?`
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = "Deleting...";

  try {
    const tournamentsSnap = await getDocs(collection(db, "tournaments"));
    for (const tDoc of tournamentsSnap.docs) {
      await unregisterPlayer(tDoc.id, playerId);
    }
    await deleteDoc(doc(db, "players", playerId));
    loadPlayers();
    loadMatchFormOptions();
    loadTMTournamentSelect();
    initCoinLogTab();
  } catch (err) {
    console.error(err);
    alert(`Something went wrong deleting ${playerName}. Try again.`);
    btn.disabled = false;
    btn.textContent = "Delete";
  }
}

// ---------------- reset player password ----------------
async function resetPlayerPassword(playerId, playerName, btn) {
  const confirmed = confirm(`Reset the password for ${playerName}? Their old password will stop working immediately.`);
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = "Resetting...";

  try {
    const newPassword = generatePassword(8);
    const salt = randomSalt();
    const passwordHash = await hashPassword(newPassword, salt);
    await updateDoc(doc(db, "players", playerId), {
      passwordSalt: salt,
      passwordHash
    });

    $("reset-name").textContent = playerName;
    $("reset-pass").textContent = newPassword;
    $("reset-credentials-card").classList.remove("hidden");
    $("reset-credentials-card").scrollIntoView({ behavior: "smooth", block: "center" });
    $("copy-reset-creds").onclick = () => {
      const msg = `Hey ${playerName}! Your Padel X password was reset:\nPassword: ${newPassword}`;
      navigator.clipboard.writeText(msg);
      $("copy-reset-creds").textContent = "Copied ✓";
      setTimeout(() => { $("copy-reset-creds").textContent = "Copy WhatsApp-ready message"; }, 1800);
    };
  } catch (err) {
    console.error(err);
    alert("Something went wrong resetting the password. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Reset password";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------- announcement ----------------
const ANNOUNCEMENT_REF = doc(db, "config", "announcement");

async function loadAnnouncementForm() {
  try {
    const snap = await getDoc(ANNOUNCEMENT_REF);
    if (snap.exists()) {
      const d = snap.data();
      $("ann-text").value = d.text || "";
      $("ann-active").checked = !!d.active;
    }
  } catch (err) {
    console.error(err);
  }
}

$("announcement-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const okEl = $("ann-success");
  hideMsg(okEl);
  const btn = $("ann-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    await setDoc(ANNOUNCEMENT_REF, {
      text: $("ann-text").value.trim(),
      active: $("ann-active").checked,
      updatedAt: serverTimestamp()
    });
    showMsg(okEl, "Announcement saved.");
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save announcement";
  }
});

initGate();

// ---------------- tiers visibility ----------------
const APP_SETTINGS_REF = doc(db, "config", "appSettings");

async function loadTiersToggle() {
  try {
    const snap = await getDoc(APP_SETTINGS_REF);
    $("tiers-enabled-toggle").checked = snap.exists() ? !!snap.data().tiersEnabled : false;
  } catch (err) {
    console.error(err);
  }
}

$("tiers-enabled-toggle").addEventListener("change", async (e) => {
  const okEl = $("tiers-success");
  hideMsg(okEl);
  try {
    await setDoc(APP_SETTINGS_REF, { tiersEnabled: e.target.checked }, { merge: true });
    showMsg(okEl, e.target.checked ? "Tier badges are now visible to players." : "Tier badges are now hidden from players.");
  } catch (err) {
    console.error(err);
    e.target.checked = !e.target.checked; // revert on failure
  }
});

// ---------------- tournaments ----------------
$("tournament-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("tr-error");
  const okEl = $("tr-success");
  hideMsg(errEl);
  hideMsg(okEl);

  const name = $("tr-name").value.trim();
  const location = $("tr-location").value.trim();
  const dateLabel = $("tr-date").value.trim();
  const status = $("tr-status").value;
  const totalTeams = parseInt($("tr-total-teams").value, 10) || 12;
  const deadlineRaw = $("tr-deadline").value;
  const championName = $("tr-champion").value.trim();
  const btn = $("tr-btn");

  if (!name) return;

  btn.disabled = true;
  btn.textContent = "Adding...";

  try {
    await addDoc(collection(db, "tournaments"), {
      name,
      location,
      dateLabel,
      status,
      totalTeams,
      registrationDeadline: deadlineRaw ? new Date(deadlineRaw) : null,
      championName: status === "completed" ? championName : "",
      participantIds: [],
      createdAt: serverTimestamp()
    });
    showMsg(okEl, `${name} added.`);
    $("tournament-form").reset();
    $("tr-status").value = "upcoming";
    $("tr-total-teams").value = "12";
    loadTournaments();
    loadTMTournamentSelect();
    initCoinParticipationTab();
    initCoinAdvancementTab();
    initCoinPlacementTab();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong while adding the tournament. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add tournament";
  }
});

async function loadTournaments() {
  const loadingEl = $("tournaments-loading");
  const tableEl = $("tournaments-table");
  const tbody = $("tournaments-tbody");
  loadingEl.classList.remove("hidden");
  tableEl.classList.add("hidden");

  try {
    const q = query(collection(db, "tournaments"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    tbody.innerHTML = "";
    snap.forEach((d) => {
      const t = d.data();
      const tr = document.createElement("tr");
      const statusClass = t.status === "live" ? "gold" : t.status === "upcoming" ? "silver" : "bronze";
      tr.innerHTML = `
        <td>${escapeHtml(t.name || "—")}</td>
        <td><span class="badge-pill ${statusClass}">${t.status || "upcoming"}</span></td>
        <td>${escapeHtml(t.dateLabel || "—")}</td>
        <td>${(t.participantIds || []).length}</td>
      `;
      tbody.appendChild(tr);
    });
    loadingEl.classList.add("hidden");
    tableEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load tournaments.";
  }
}

// ---------------- record match result (rating engine) ----------------
let activePlayersCache = [];

async function loadMatchFormOptions() {
  try {
    const [tournamentsSnap, playersSnap] = await Promise.all([
      getDocs(query(collection(db, "tournaments"), orderBy("createdAt", "desc"))),
      getDocs(query(collection(db, "players"), orderBy("name")))
    ]);

    const tournamentSelect = $("mt-tournament");
    tournamentSelect.innerHTML = "";
    tournamentsSnap.forEach((d) => {
      const t = d.data();
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${t.name || "Untitled"} (${t.status || "upcoming"})`;
      tournamentSelect.appendChild(opt);
    });
    if (tournamentsSnap.empty) {
      tournamentSelect.innerHTML = '<option value="">Add a tournament first</option>';
    }

    activePlayersCache = playersSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.isActive !== false);

    const playerSelects = [$("mt-t1p1"), $("mt-t1p2"), $("mt-t2p1"), $("mt-t2p2")];
    playerSelects.forEach((sel) => {
      sel.innerHTML = '<option value="">Select player</option>';
      activePlayersCache.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name || "—"} (${p.playerCode || "—"}) — ${Math.round(p.ratingPoints ?? 1000)} pts`;
        sel.appendChild(opt);
      });
    });
  } catch (err) {
    console.error(err);
  }
}

$("match-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("match-error");
  const okEl = $("match-success");
  hideMsg(errEl);
  hideMsg(okEl);
  $("match-result-summary").classList.add("hidden");

  const tournamentId = $("mt-tournament").value;
  const round = $("mt-round").value.trim();
  const ids = [$("mt-t1p1").value, $("mt-t1p2").value, $("mt-t2p1").value, $("mt-t2p2").value];
  const score1 = parseInt($("mt-score1").value, 10);
  const score2 = parseInt($("mt-score2").value, 10);
  const btn = $("match-btn");

  if (!tournamentId) {
    showMsg(errEl, "Pick a tournament first.");
    return;
  }
  if (ids.some((id) => !id)) {
    showMsg(errEl, "Pick all 4 players.");
    return;
  }
  if (new Set(ids).size !== 4) {
    showMsg(errEl, "A player can't appear twice in the same match.");
    return;
  }
  if (Number.isNaN(score1) || Number.isNaN(score2) || score1 < 0 || score2 < 0) {
    showMsg(errEl, "Enter valid game scores for both teams.");
    return;
  }
  if (score1 === score2) {
    showMsg(errEl, "Scores can't be tied — one team has to have won.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Calculating...";

  try {
    // fetch fresh player docs right before computing, so back-to-back matches
    // in the same session always use up-to-date ratings, not stale cache
    const freshDocs = await Promise.all(ids.map((id) => getDoc(doc(db, "players", id))));
    if (freshDocs.some((d) => !d.exists())) {
      showMsg(errEl, "One of the selected players no longer exists.");
      return;
    }
    const players = freshDocs.map((d) => ({ id: d.id, ...d.data() }));
    const team1 = [players[0], players[1]];
    const team2 = [players[2], players[3]];

    const results = computeMatchPointChanges(team1, team2, score1, score2);

    const batch = writeBatch(db);
    const matchRef = doc(collection(db, "matches"));
    batch.set(matchRef, {
      tournamentId,
      round: round || "",
      team1: [team1[0].id, team1[1].id],
      team2: [team2[0].id, team2[1].id],
      team1Games: score1,
      team2Games: score2,
      createdAt: serverTimestamp()
    });

    results.forEach((r) => {
      batch.update(doc(db, "players", r.playerId), {
        ratingPoints: r.ratingAfter,
        matchesPlayed: increment(1),
        wins: increment(r.won ? 1 : 0),
        losses: increment(r.won ? 0 : 1)
      });
      const historyRef = doc(collection(db, "ratingHistory"));
      batch.set(historyRef, {
        playerId: r.playerId,
        matchId: matchRef.id,
        tournamentId,
        ratingBefore: r.ratingBefore,
        opponentAvgRating: r.opponentAvg,
        expectedScore: r.expectedScore,
        actualResult: r.actualResult,
        marginMultiplier: r.marginMultiplier,
        kFactor: r.kFactor,
        pointsChange: r.pointsChange,
        ratingAfter: r.ratingAfter,
        createdAt: serverTimestamp()
      });
    });

    await batch.commit();

    const summaryEl = $("match-result-summary");
    summaryEl.innerHTML = results.map((r) => {
      const p = players.find((pl) => pl.id === r.playerId);
      const sign = r.pointsChange >= 0 ? "+" : "";
      const color = r.pointsChange >= 0 ? "var(--live)" : "var(--danger)";
      return `<div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
        <span>${escapeHtml(p.name || "—")}</span>
        <span style="color:${color}; font-family:var(--font-mono); font-weight:700;">${sign}${r.pointsChange.toFixed(1)} → ${Math.round(r.ratingAfter)}</span>
      </div>`;
    }).join("");
    summaryEl.classList.remove("hidden");

    showMsg(okEl, "Match recorded and ratings updated.");
    $("mt-t1p1").value = "";
    $("mt-t1p2").value = "";
    $("mt-t2p1").value = "";
    $("mt-t2p2").value = "";
    $("mt-score1").value = "";
    $("mt-score2").value = "";
    loadMatchFormOptions(); // refresh point totals shown in the dropdowns
    loadPlayers(); // refresh the roster table too
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong recording the match. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Record match & update ratings";
  }
});

// ---------------- tournament team management (numbered slot grid) ----------------
$("tm-tournament").addEventListener("change", (e) => {
  if (e.target.value) loadTeamGrid(e.target.value);
});

async function loadTMTournamentSelect() {
  try {
    const snap = await getDocs(query(collection(db, "tournaments"), orderBy("createdAt", "desc")));
    const tournaments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const tmSelect = $("tm-tournament");
    tmSelect.innerHTML = "";
    tournaments.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name || "Untitled"} (${t.status || "upcoming"})`;
      tmSelect.appendChild(opt);
    });

    if (tournaments.length === 0) {
      $("tm-loading").textContent = "Add a tournament first.";
      return;
    }
    const upcoming = tournaments.find((t) => t.status === "upcoming");
    tmSelect.value = upcoming ? upcoming.id : tournaments[0].id;
    loadTeamGrid(tmSelect.value);
  } catch (err) {
    console.error(err);
  }
}

async function loadTeamGrid(tournamentId) {
  const loadingEl = $("tm-loading");
  const gridEl = $("tm-grid");
  const errEl = $("tm-error");
  loadingEl.classList.remove("hidden");
  gridEl.classList.add("hidden");
  hideMsg(errEl);

  try {
    const [tSnap, teams, allPlayersSnap] = await Promise.all([
      getDoc(doc(db, "tournaments", tournamentId)),
      fetchTeams(tournamentId),
      getDocs(query(collection(db, "players"), orderBy("name")))
    ]);
    if (!tSnap.exists()) return;
    const totalTeams = tSnap.data().totalTeams || 12;

    const allPlayers = allPlayersSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.isActive !== false);
    const nameById = new Map(allPlayers.map((p) => [p.id, `${p.name || "—"} (${p.playerCode || "—"})`]));

    const assignedIds = new Set();
    teams.forEach((tm) => { if (tm.player1Id) assignedIds.add(tm.player1Id); if (tm.player2Id) assignedIds.add(tm.player2Id); });
    const availablePlayers = allPlayers.filter((p) => !assignedIds.has(p.id));

    const teamByNumber = new Map(teams.map((tm) => [tm.teamNumber, tm]));

    let html = "";

    for (let n = 1; n <= totalTeams; n++) {
      const team = teamByNumber.get(n);
      const playerCell = (playerId, slot) => {
        if (playerId) {
          return `
            <div class="team-slot-player">
              <span class="team-slot-player-name">${escapeHtml(nameById.get(playerId) || "Unknown player")}</span>
              <button class="team-slot-remove-btn" data-remove-player="${playerId}" data-tournament="${tournamentId}" title="Remove from this tournament — they'll need to register again if they want back in">×</button>
            </div>`;
        }
        const options = availablePlayers.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.playerCode || "")})</option>`).join("");
        return `
          <div class="team-slot-player">
            <select class="team-slot-add-select" data-assign-team="${n}" data-assign-slot="${slot}" data-tournament="${tournamentId}">
              <option value="">+ Add player</option>
              ${options}
            </select>
          </div>`;
      };

      const groupOptions = [1, 2, 3].map((g) =>
        `<option value="${g}" ${team?.group === g ? "selected" : ""}>Group ${g}</option>`
      ).join("");
      const groupSelect = team
        ? `<select class="team-slot-group-select" data-set-group="${team.id}" data-tournament="${tournamentId}"><option value="">Group —</option>${groupOptions}</select>`
        : `<select class="team-slot-group-select" disabled><option>Group —</option></select>`;

      html += `
        <div class="team-slot-row">
          <div class="team-slot-row-head">
            <span class="team-slot-number">Team ${n}</span>
            ${groupSelect}
          </div>
          <div class="team-slot-players">
            ${playerCell(team?.player1Id, "player1")}
            ${playerCell(team?.player2Id, "player2")}
          </div>
        </div>
      `;
    }

    const waitingList = tSnap.data().waitingList || [];
    const waitlistEl = $("tm-waitlist");
    if (waitingList.length > 0) {
      const names = waitingList.map((id) => nameById.get(id) || "Unknown player").join(", ");
      waitlistEl.textContent = `Waiting list (${waitingList.length}): ${names}`;
      waitlistEl.classList.remove("hidden");
    } else {
      waitlistEl.classList.add("hidden");
    }

    gridEl.innerHTML = html;

    gridEl.querySelectorAll("[data-assign-team]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        if (!sel.value) return;
        sel.disabled = true;
        try {
          await assignToSlot(tournamentId, parseInt(sel.dataset.assignTeam, 10), sel.dataset.assignSlot, sel.value);
          loadTeamGrid(tournamentId);
        } catch (err) {
          console.error(err);
          showMsg(errEl, "Something went wrong assigning that player.");
          sel.disabled = false;
        }
      });
    });

    gridEl.querySelectorAll("[data-remove-player]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await unregisterPlayer(tournamentId, btn.dataset.removePlayer);
          loadTeamGrid(tournamentId);
        } catch (err) {
          console.error(err);
          showMsg(errEl, "Something went wrong removing that player.");
          btn.disabled = false;
        }
      });
    });

    gridEl.querySelectorAll("[data-set-group]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        sel.disabled = true;
        try {
          await setTeamGroup(tournamentId, sel.dataset.setGroup, sel.value ? Number(sel.value) : null);
        } catch (err) {
          console.error(err);
        } finally {
          sel.disabled = false;
        }
      });
    });

    loadingEl.classList.add("hidden");
    gridEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load tournament data.";
  }
}

// =========================================================================
// ---------------- Coins system (fully manual — no automatic awards) ----------------
// Every award goes through one atomic batch write that: (1) increments the
// player's coinsBalance, (2) writes an audit-trail entry to coinTransactions,
// and (3) marks the tournament so the same player can never be double-awarded
// the same coin type again. This is the ONLY place coinsBalance ever changes.
// =========================================================================

const COIN_AMOUNTS = {
  participation: 10,
  advancement: 20,
  placement: { 1: 150, 2: 100, 3: 75 }
};

async function loadCoinTournamentSelect(selectId) {
  const snap = await getDocs(query(collection(db, "tournaments"), orderBy("createdAt", "desc")));
  const select = $(selectId);
  select.innerHTML = "";
  if (snap.empty) {
    select.innerHTML = '<option value="">Add a tournament first</option>';
    return [];
  }
  const tournaments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  tournaments.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name || "Untitled"} (${t.status || "upcoming"})`;
    select.appendChild(opt);
  });
  return tournaments;
}

async function fetchPlayersByIds(ids) {
  const docs = await Promise.all(ids.map((id) => getDoc(doc(db, "players", id))));
  return docs.filter((d) => d.exists()).map((d) => ({ id: d.id, ...d.data() }));
}

function coinPlayerRowHtml(p, awarded) {
  return `
    <label style="display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); font-size:13.5px; ${awarded ? "opacity:.5;" : ""}">
      <input type="checkbox" value="${p.id}" ${awarded ? "disabled" : ""} style="width:auto;">
      <span style="flex:1;">${escapeHtml(p.name || "—")} <span style="color:var(--text-soft); font-family:var(--font-mono); font-size:11px;">${escapeHtml(p.playerCode || "")}</span></span>
      ${awarded ? '<span class="badge-pill gold">✓ Awarded</span>' : ""}
    </label>
  `;
}

// ---------------- 1. Participation (+10) ----------------

async function initCoinParticipationTab() {
  const tournaments = await loadCoinTournamentSelect("coin-p-tournament");
  if (tournaments.length > 0) loadCoinParticipationList(tournaments[0].id);
}

$("coin-p-tournament").addEventListener("change", (e) => {
  if (e.target.value) loadCoinParticipationList(e.target.value);
});

async function loadCoinParticipationList(tournamentId) {
  const loadingEl = $("coin-p-loading");
  const wrapEl = $("coin-p-list-wrap");
  loadingEl.classList.remove("hidden");
  wrapEl.classList.add("hidden");
  hideMsg($("coin-p-error"));
  hideMsg($("coin-p-success"));
  $("coin-p-summary").classList.add("hidden");

  try {
    const tSnap = await getDoc(doc(db, "tournaments", tournamentId));
    if (!tSnap.exists()) return;
    const t = tSnap.data();
    const alreadyAwarded = new Set((t.coinsAwarded && t.coinsAwarded.participation) || []);
    const players = await fetchPlayersByIds(t.participantIds || []);
    players.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    $("coin-p-list").innerHTML = players.map((p) => coinPlayerRowHtml(p, alreadyAwarded.has(p.id))).join("")
      || '<div class="hint">No registered players in this tournament yet.</div>';

    loadingEl.classList.add("hidden");
    wrapEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the participant list.";
  }
}

$("coin-p-select-all-btn").addEventListener("click", () => {
  $("coin-p-list").querySelectorAll('input[type="checkbox"]:not([disabled])').forEach((cb) => { cb.checked = true; });
});

$("coin-p-btn").addEventListener("click", () => awardTournamentCoins({
  tournamentId: $("coin-p-tournament").value,
  listElId: "coin-p-list",
  errorElId: "coin-p-error",
  successElId: "coin-p-success",
  summaryElId: "coin-p-summary",
  type: "participation",
  amount: COIN_AMOUNTS.participation,
  note: "Tournament participation",
  reload: () => loadCoinParticipationList($("coin-p-tournament").value)
}));

// ---------------- 2. Group-stage advancement (+20) ----------------

async function initCoinAdvancementTab() {
  const tournaments = await loadCoinTournamentSelect("coin-a-tournament");
  if (tournaments.length > 0) loadCoinAdvancementList(tournaments[0].id);
}

$("coin-a-tournament").addEventListener("change", (e) => {
  if (e.target.value) loadCoinAdvancementList(e.target.value);
});

async function loadCoinAdvancementList(tournamentId) {
  const loadingEl = $("coin-a-loading");
  const wrapEl = $("coin-a-list-wrap");
  loadingEl.classList.remove("hidden");
  wrapEl.classList.add("hidden");
  hideMsg($("coin-a-error"));
  hideMsg($("coin-a-success"));
  $("coin-a-summary").classList.add("hidden");

  try {
    const tSnap = await getDoc(doc(db, "tournaments", tournamentId));
    if (!tSnap.exists()) return;
    const t = tSnap.data();
    const alreadyAwarded = new Set((t.coinsAwarded && t.coinsAwarded.advancement) || []);
    const players = await fetchPlayersByIds(t.participantIds || []);
    players.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    $("coin-a-list").innerHTML = players.map((p) => coinPlayerRowHtml(p, alreadyAwarded.has(p.id))).join("")
      || '<div class="hint">No registered players in this tournament yet.</div>';

    loadingEl.classList.add("hidden");
    wrapEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the participant list.";
  }
}

$("coin-a-select-all-btn").addEventListener("click", () => {
  $("coin-a-list").querySelectorAll('input[type="checkbox"]:not([disabled])').forEach((cb) => { cb.checked = true; });
});

$("coin-a-btn").addEventListener("click", () => awardTournamentCoins({
  tournamentId: $("coin-a-tournament").value,
  listElId: "coin-a-list",
  errorElId: "coin-a-error",
  successElId: "coin-a-success",
  summaryElId: "coin-a-summary",
  type: "advancement",
  amount: COIN_AMOUNTS.advancement,
  note: "Group-stage advancement",
  reload: () => loadCoinAdvancementList($("coin-a-tournament").value)
}));

// Shared awarding routine for participation/advancement — a flat amount to a
// set of individually-selected players, in one atomic batch write.
async function awardTournamentCoins({ tournamentId, listElId, errorElId, successElId, summaryElId, type, amount, note, reload }) {
  const errEl = $(errorElId);
  const okEl = $(successElId);
  hideMsg(errEl);
  hideMsg(okEl);

  if (!tournamentId) {
    showMsg(errEl, "Pick a tournament first.");
    return;
  }

  const checked = Array.from($(listElId).querySelectorAll('input[type="checkbox"]:checked:not([disabled])')).map((cb) => cb.value);
  if (checked.length === 0) {
    showMsg(errEl, "Select at least one player.");
    return;
  }

  const confirmed = confirm(`Award ${amount} coins each to ${checked.length} player(s)? This can't be undone from here.`);
  if (!confirmed) return;

  try {
    const players = await fetchPlayersByIds(checked);
    const batch = writeBatch(db);

    players.forEach((p) => {
      batch.update(doc(db, "players", p.id), { coinsBalance: increment(amount) });
      const txRef = doc(collection(db, "coinTransactions"));
      batch.set(txRef, {
        playerId: p.id,
        amount,
        type,
        tournamentId,
        note,
        balanceAfter: (p.coinsBalance ?? 0) + amount,
        createdAt: serverTimestamp()
      });
    });

    batch.update(doc(db, "tournaments", tournamentId), {
      [`coinsAwarded.${type}`]: arrayUnion(...checked)
    });

    await batch.commit();

    const summaryEl = $(summaryElId);
    summaryEl.innerHTML = players.map((p) => `
      <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
        <span>${escapeHtml(p.name || "—")}</span>
        <span style="color:var(--live); font-family:var(--font-mono); font-weight:700;">+${amount} → ${(p.coinsBalance ?? 0) + amount}</span>
      </div>
    `).join("");
    summaryEl.classList.remove("hidden");

    showMsg(okEl, `${amount} coins awarded to ${players.length} player(s).`);
    reload();
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong awarding coins. No coins were given — try again.");
  }
}

// ---------------- 3. Final placement (150 / 100 / 75) ----------------

async function initCoinPlacementTab() {
  const tournaments = await loadCoinTournamentSelect("coin-pl-tournament");
  if (tournaments.length > 0) loadCoinPlacementList(tournaments[0].id);
}

$("coin-pl-tournament").addEventListener("change", (e) => {
  if (e.target.value) loadCoinPlacementList(e.target.value);
});

async function loadCoinPlacementList(tournamentId) {
  const loadingEl = $("coin-pl-loading");
  const listEl = $("coin-pl-list");
  const btn = $("coin-pl-btn");
  loadingEl.classList.remove("hidden");
  listEl.classList.add("hidden");
  btn.classList.add("hidden");
  hideMsg($("coin-pl-error"));
  hideMsg($("coin-pl-success"));
  $("coin-pl-summary").classList.add("hidden");

  try {
    const [tSnap, teams] = await Promise.all([
      getDoc(doc(db, "tournaments", tournamentId)),
      fetchTeams(tournamentId)
    ]);
    if (!tSnap.exists()) return;
    const t = tSnap.data();
    const alreadyAwarded = new Set((t.coinsAwarded && t.coinsAwarded.placement) || []);

    const fullTeams = teams.filter((tm) => tm.player1Id && tm.player2Id);
    const players = await fetchPlayersByIds(fullTeams.flatMap((tm) => [tm.player1Id, tm.player2Id]));
    const playerById = new Map(players.map((p) => [p.id, p]));

    if (fullTeams.length === 0) {
      listEl.innerHTML = '<div class="hint">No complete teams (both players assigned) in this tournament yet.</div>';
    } else {
      listEl.innerHTML = fullTeams.map((tm) => {
        const p1 = playerById.get(tm.player1Id);
        const p2 = playerById.get(tm.player2Id);
        const awarded = alreadyAwarded.has(tm.player1Id) && alreadyAwarded.has(tm.player2Id);
        return `
          <div style="background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
            <div>
              <div style="font-family:var(--font-mono); font-size:11.5px; color:var(--text-soft); margin-bottom:2px;">Team ${tm.teamNumber}</div>
              <div style="font-size:13.5px;">${escapeHtml(p1?.name || "—")} &amp; ${escapeHtml(p2?.name || "—")}</div>
            </div>
            ${awarded
              ? '<span class="badge-pill gold">✓ Awarded</span>'
              : `<select class="team-slot-group-select" data-team-position data-p1="${tm.player1Id}" data-p2="${tm.player2Id}" style="width:130px;">
                  <option value="">No placement</option>
                  <option value="1">🥇 1st (150)</option>
                  <option value="2">🥈 2nd (100)</option>
                  <option value="3">🥉 3rd (75)</option>
                </select>`
            }
          </div>
        `;
      }).join("");
    }

    loadingEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    btn.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the teams.";
  }
}

$("coin-pl-btn").addEventListener("click", async () => {
  const tournamentId = $("coin-pl-tournament").value;
  const errEl = $("coin-pl-error");
  const okEl = $("coin-pl-success");
  hideMsg(errEl);
  hideMsg(okEl);

  const selects = Array.from($("coin-pl-list").querySelectorAll("[data-team-position]")).filter((sel) => sel.value);
  if (selects.length === 0) {
    showMsg(errEl, "Pick a placement for at least one team.");
    return;
  }

  const lines = selects.map((sel) => {
    const pos = Number(sel.value);
    const label = pos === 1 ? "1st" : pos === 2 ? "2nd" : "3rd";
    return `${label} place — ${COIN_AMOUNTS.placement[pos]} coins each`;
  });
  const confirmed = confirm(`Award placement coins for ${selects.length} team(s)?\n\n${lines.join("\n")}\n\nThis can't be undone from here.`);
  if (!confirmed) return;

  try {
    const allIds = [];
    selects.forEach((sel) => { allIds.push(sel.dataset.p1, sel.dataset.p2); });
    const players = await fetchPlayersByIds(allIds);
    const playerById = new Map(players.map((p) => [p.id, p]));

    const batch = writeBatch(db);
    const summaryRows = [];
    const awardedIds = [];

    selects.forEach((sel) => {
      const pos = Number(sel.value);
      const amount = COIN_AMOUNTS.placement[pos];
      const label = pos === 1 ? "1st place" : pos === 2 ? "2nd place" : "3rd place";
      [sel.dataset.p1, sel.dataset.p2].forEach((pid) => {
        const p = playerById.get(pid);
        if (!p) return;
        const newBalance = (p.coinsBalance ?? 0) + amount;
        batch.update(doc(db, "players", pid), { coinsBalance: increment(amount) });
        const txRef = doc(collection(db, "coinTransactions"));
        batch.set(txRef, {
          playerId: pid,
          amount,
          type: "placement",
          position: pos,
          tournamentId,
          note: label,
          balanceAfter: newBalance,
          createdAt: serverTimestamp()
        });
        summaryRows.push({ name: p.name || "—", amount, newBalance });
        awardedIds.push(pid);
      });
    });

    batch.update(doc(db, "tournaments", tournamentId), {
      "coinsAwarded.placement": arrayUnion(...awardedIds)
    });

    await batch.commit();

    const summaryEl = $("coin-pl-summary");
    summaryEl.innerHTML = summaryRows.map((r) => `
      <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
        <span>${escapeHtml(r.name)}</span>
        <span style="color:var(--live); font-family:var(--font-mono); font-weight:700;">+${r.amount} → ${r.newBalance}</span>
      </div>
    `).join("");
    summaryEl.classList.remove("hidden");

    showMsg(okEl, `Placement coins awarded for ${selects.length} team(s).`);
    loadCoinPlacementList(tournamentId);
  } catch (err) {
    console.error(err);
    showMsg(errEl, "Something went wrong awarding placement coins. No coins were given — try again.");
  }
});

// ---------------- 4. Player coin log (audit trail) ----------------

async function initCoinLogTab() {
  try {
    const snap = await getDocs(query(collection(db, "players"), orderBy("name")));
    const select = $("coin-log-player");
    const previousValue = select.value;
    select.innerHTML = '<option value="">Select a player</option>';
    snap.forEach((d) => {
      const p = d.data();
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${p.name || "—"} (${p.playerCode || "—"})`;
      select.appendChild(opt);
    });
    if (previousValue && snap.docs.some((d) => d.id === previousValue)) select.value = previousValue;
  } catch (err) {
    console.error(err);
  }
}

$("coin-log-player").addEventListener("change", (e) => {
  if (e.target.value) loadCoinLog(e.target.value);
  else $("coin-log-body").classList.add("hidden");
});

async function loadCoinLog(playerId) {
  const loadingEl = $("coin-log-loading");
  const bodyEl = $("coin-log-body");
  loadingEl.classList.remove("hidden");
  bodyEl.classList.add("hidden");

  try {
    const [pSnap, txSnap] = await Promise.all([
      getDoc(doc(db, "players", playerId)),
      getDocs(query(collection(db, "coinTransactions"), where("playerId", "==", playerId)))
    ]);
    if (!pSnap.exists()) return;
    const p = pSnap.data();

    $("coin-log-balance").textContent = `${Math.round(p.coinsBalance ?? 0)} coins — current balance for ${p.name || "—"}`;

    // Sorted client-side (not via Firestore orderBy) to avoid requiring a
    // composite index for a simple single-player equality + date query.
    const transactions = txSnap.docs
      .map((d) => d.data())
      .sort((a, b) => {
        const at = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
        const bt = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
        return bt - at;
      });

    const listEl = $("coin-log-list");
    const emptyEl = $("coin-log-empty");
    if (transactions.length === 0) {
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
      listEl.innerHTML = transactions.map((tx) => {
        const date = tx.createdAt?.toDate
          ? tx.createdAt.toDate().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
          : "—";
        const sign = tx.amount >= 0 ? "+" : "";
        const color = tx.amount >= 0 ? "var(--live)" : "var(--danger)";
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <div>
              <div>${escapeHtml(tx.note || tx.type || "—")}</div>
              <div style="font-size:11px; color:var(--text-soft); margin-top:2px;">${date}</div>
            </div>
            <span style="color:${color}; font-family:var(--font-mono); font-weight:700;">${sign}${tx.amount} → ${tx.balanceAfter ?? "—"}</span>
          </div>
        `;
      }).join("");
    }

    loadingEl.classList.add("hidden");
    bodyEl.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the coin log.";
  }
}
