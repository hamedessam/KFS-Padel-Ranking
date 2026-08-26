import {
  db, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  query, orderBy, runTransaction, writeBatch, increment, serverTimestamp
} from "./firebase-config.js";
import { hashPassword, randomSalt, generatePassword, playerCodeFromSeq, tierMeta, tierFromPoints, isFoundingMember, computeMatchPointChanges } from "./utils.js";
import { fetchTeams, assignToSlot, unregisterPlayer, setTeamGroup } from "./teams.js";

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
      const msg = `Hey ${name}! Here are your login details for KFS Padel Ranking:\nCode: ${playerCode}\nPassword: ${password}`;
      navigator.clipboard.writeText(msg);
      $("copy-creds").textContent = "Copied ✓";
      setTimeout(() => { $("copy-creds").textContent = "Copy WhatsApp-ready message"; }, 1800);
    };

    showMsg(okEl, `${name} added successfully. Assign them to a team in the Tournament Manager tab whenever you're ready.`);
    $("add-form").reset();
    loadPlayers();
    loadMatchFormOptions();
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
        <td><button class="link-btn" data-reset-player="${d.id}" data-player-name="${escapeHtml(p.name || "—")}" type="button" style="font-size:12px;">Reset password</button></td>
      `;
      tbody.appendChild(tr);
    });
    loadingEl.classList.add("hidden");
    tableEl.classList.remove("hidden");

    tbody.querySelectorAll("[data-reset-player]").forEach((btn) => {
      btn.addEventListener("click", () => resetPlayerPassword(btn.dataset.resetPlayer, btn.dataset.playerName, btn));
    });
  } catch (err) {
    console.error(err);
    loadingEl.textContent = "Couldn't load the players.";
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
      const msg = `Hey ${playerName}! Your KFS Padel Ranking password was reset:\nPassword: ${newPassword}`;
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

    let html = `
      <div class="team-slot-grid-header">
        <span>#</span><span>Player 1</span><span>Player 2</span><span>Group</span>
      </div>
    `;

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
          <select class="team-slot-add-select" data-assign-team="${n}" data-assign-slot="${slot}" data-tournament="${tournamentId}">
            <option value="">+ Add player</option>
            ${options}
          </select>`;
      };

      const groupOptions = [1, 2, 3].map((g) =>
        `<option value="${g}" ${team?.group === g ? "selected" : ""}>Group ${g}</option>`
      ).join("");

      html += `
        <div class="team-slot-row">
          <div class="team-slot-number">${n}</div>
          <div>${playerCell(team?.player1Id, "player1")}</div>
          <div>${playerCell(team?.player2Id, "player2")}</div>
          <div>
            ${team ? `<select class="team-slot-group-select" data-set-group="${team.id}" data-tournament="${tournamentId}">
                <option value="">—</option>${groupOptions}
              </select>` : `<select class="team-slot-group-select" disabled><option>—</option></select>`}
          </div>
        </div>
      `;
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
