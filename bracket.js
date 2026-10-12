// Tournament results: group stage -> knockout -> "calculate points for everyone".
//
// Two halves:
//   1. Pure functions (no Firestore): build the fixtures, work out standings and
//      who plays whom next, and compute every player's point changes.
//   2. Small Firestore helpers: save fixtures / scores, then apply (or undo) the
//      points for the WHOLE tournament in one all-or-nothing transaction.
//
// Points are never touched while scores are being entered. They're only written
// when the admin confirms "Calculate points", and only if every player and every
// match checks out — otherwise nothing is written at all.

import {
  db, collection, doc, getDoc, getDocs, updateDoc, query, where,
  runTransaction, writeBatch, serverTimestamp, Timestamp
} from "./firebase-config.js";
import { computeMatchPointChanges, isRanked } from "./utils.js";

const GROUPS = [1, 2, 3];
const EXPECTED_FIXTURES = { group: 18, ko: 3, semi: 1, final: 1 };

// ---------------------------------------------------------------- helpers
function makeFixture({ id, stage, group = null, round = null, order, label, a, b }) {
  return {
    id, stage, group, round, order, label,
    team1Id: a.id, team2Id: b.id,
    team1Number: a.teamNumber, team2Number: b.teamNumber,
    team1Players: [a.player1Id, a.player2Id],
    team2Players: [b.player1Id, b.player2Id],
    score1: null, score2: null, done: false
  };
}
const teamFromRow = (r) => ({ id: r.teamId, teamNumber: r.teamNumber, player1Id: r.players[0], player2Id: r.players[1] });
const teamFromSide = (f, side) => side === 1
  ? { id: f.team1Id, teamNumber: f.team1Number, player1Id: f.team1Players[0], player2Id: f.team1Players[1] }
  : { id: f.team2Id, teamNumber: f.team2Number, player1Id: f.team2Players[0], player2Id: f.team2Players[1] };
export const winnerSide = (f) => (f.score1 > f.score2 ? 1 : 2);
const samePair = (a, b) =>
  (a.team1Id === b.team1Id && a.team2Id === b.team2Id) || (a.team1Id === b.team2Id && a.team2Id === b.team1Id);

export function fixturePlayerIds(fixtures) {
  const ids = new Set();
  fixtures.forEach((f) => [...f.team1Players, ...f.team2Players].forEach((id) => id && ids.add(id)));
  return [...ids];
}

// ------------------------------------------------------------- readiness
export function checkReadiness(teams, playersById) {
  const blocking = [];
  const warnings = [];
  const byGroup = { 1: [], 2: [], 3: [] };
  let ungrouped = 0;
  teams.forEach((tm) => { if (byGroup[tm.group]) byGroup[tm.group].push(tm); else ungrouped++; });
  GROUPS.forEach((g) => {
    if (byGroup[g].length !== 4) blocking.push(`Group ${g} has ${byGroup[g].length} team(s) — it needs exactly 4 (set groups in Tournament Manager).`);
  });
  if (ungrouped > 0) blocking.push(`${ungrouped} team(s) have no group yet.`);
  teams.forEach((tm) => {
    if (byGroup[tm.group] && (!tm.player1Id || !tm.player2Id)) blocking.push(`Team ${tm.teamNumber} doesn't have 2 players yet.`);
  });
  teams.forEach((tm) => [tm.player1Id, tm.player2Id].filter(Boolean).forEach((id) => {
    const p = playersById.get(id);
    if (!p) { blocking.push(`A player on Team ${tm.teamNumber} no longer exists.`); return; }
    if (!isRanked(p)) warnings.push(`${p.name || "—"} (Team ${tm.teamNumber}) has no rank yet — give them a rank before calculating points.`);
  }));
  return { blocking, warnings };
}

// -------------------------------------------------------- group fixtures
// 3 groups x 4 teams, everyone plays everyone: 6 matches per group, 18 total.
// Order goes round by round across the groups (G1,G2,G3 round 1, then round 2...).
export function generateGroupFixtures(teams) {
  const byGroup = {};
  teams.forEach((tm) => { (byGroup[tm.group] = byGroup[tm.group] || []).push(tm); });
  const ROUNDS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  const out = [];
  let order = 0;
  for (let r = 0; r < ROUNDS.length; r++) {
    for (const g of GROUPS) {
      const gt = (byGroup[g] || []).slice().sort((x, y) => x.teamNumber - y.teamNumber);
      ROUNDS[r].forEach(([i, j], k) => {
        out.push(makeFixture({
          id: `g${g}-r${r + 1}-m${k + 1}`, stage: "group", group: g, round: r + 1, order: ++order,
          label: `Group ${g} · Round ${r + 1}`, a: gt[i], b: gt[j]
        }));
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- standings
// Order: wins, then game difference, then games won, then head-to-head (for a
// 2-team tie). If a tie that matters (for 1st/2nd/qualifying) is still
// unresolved the admin has to pick — overrides.groups[g] = [firstId, secondId].
export function computeStandings(fixtures, overrides = {}) {
  const res = {};
  for (const g of GROUPS) {
    const fx = fixtures.filter((f) => f.stage === "group" && f.group === g);
    const rows = new Map();
    const touch = (id, num, players) => {
      if (!rows.has(id)) rows.set(id, { teamId: id, teamNumber: num, players, played: 0, wins: 0, losses: 0, gf: 0, ga: 0, diff: 0 });
    };
    fx.forEach((f) => { touch(f.team1Id, f.team1Number, f.team1Players); touch(f.team2Id, f.team2Number, f.team2Players); });
    fx.filter((f) => f.done).forEach((f) => {
      const a = rows.get(f.team1Id), b = rows.get(f.team2Id);
      a.played++; b.played++;
      a.gf += f.score1; a.ga += f.score2; b.gf += f.score2; b.ga += f.score1;
      if (f.score1 > f.score2) { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
    });
    rows.forEach((r) => { r.diff = r.gf - r.ga; });

    const list = [...rows.values()].sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.gf - x.gf || x.teamNumber - y.teamNumber);
    const complete = fx.length > 0 && fx.every((f) => f.done);
    const sameKey = (x, y) => x.wins === y.wins && x.diff === y.diff && x.gf === y.gf;
    const tieWithNext = list.map(() => false);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && sameKey(list[i], list[j + 1])) j++;
      const size = j - i + 1;
      if (size === 2) {
        const a = list[i], b = list[j];
        const h = fx.find((f) => f.done && ((f.team1Id === a.teamId && f.team2Id === b.teamId) || (f.team1Id === b.teamId && f.team2Id === a.teamId)));
        if (h) {
          const w = h.score1 > h.score2 ? h.team1Id : h.team2Id;
          if (w === b.teamId) { list[i] = b; list[j] = a; }
        }
      } else if (size >= 3) {
        for (let k = i; k < j; k++) tieWithNext[k] = true;
      }
      i = j + 1;
    }

    let ordered = list;
    let overridden = false;
    const ov = overrides && overrides.groups && overrides.groups[g];
    if (complete && Array.isArray(ov) && ov.length === 2 && ov[0] !== ov[1] && rows.has(ov[0]) && rows.has(ov[1])) {
      ordered = [rows.get(ov[0]), rows.get(ov[1]), ...list.filter((r) => r.teamId !== ov[0] && r.teamId !== ov[1])];
      overridden = true;
    }
    const unresolved = complete && !overridden && (tieWithNext[0] || tieWithNext[1]);
    res[g] = { rows: ordered, complete, unresolved, overridden };
  }
  return res;
}

// -------------------------------------------------------------- knockout
// 1st of G1 v 2nd of G3, 2nd of G1 v 1st of G2, 1st of G3 v 2nd of G2.
export function deriveKnockout(standings) {
  if (!GROUPS.every((g) => standings[g].complete && !standings[g].unresolved)) return null;
  const q = (g, p) => standings[g].rows[p - 1];
  const pairs = [[q(1, 1), q(3, 2)], [q(1, 2), q(2, 1)], [q(3, 1), q(2, 2)]];
  return pairs.map(([a, b], i) => makeFixture({
    id: `ko-${i + 1}`, stage: "ko", order: 19 + i, label: `Knockout ${i + 1}`, a: teamFromRow(a), b: teamFromRow(b)
  }));
}

// The knockout winner with the best result (biggest game margin, then most
// games won) goes straight to the final; the other two meet in the semi-final.
export function deriveSemiAndBye(koFixtures, overrides = {}) {
  if (koFixtures.length !== 3 || !koFixtures.every((f) => f.done)) return null;
  const info = koFixtures.map((f) => ({
    ...teamFromSide(f, winnerSide(f)),
    margin: Math.abs(f.score1 - f.score2),
    gamesWon: Math.max(f.score1, f.score2)
  }));
  const sorted = [...info].sort((a, b) => b.margin - a.margin || b.gamesWon - a.gamesWon);
  const top = sorted[0];
  const tied = info.filter((x) => x.margin === top.margin && x.gamesWon === top.gamesWon);
  let bye = top;
  let needsDecision = tied.length > 1;
  const ovId = overrides && overrides.bye;
  if (ovId) {
    const f = info.find((x) => x.id === ovId);
    if (f) { bye = f; needsDecision = false; }
  }
  if (needsDecision) return { needsDecision: true, candidates: tied };
  const others = info.filter((x) => x.id !== bye.id);
  const semi = makeFixture({ id: "semi", stage: "semi", order: 22, label: "Semi-final", a: others[0], b: others[1] });
  return { needsDecision: false, bye, semi };
}

export function deriveFinal(semiFixture, bye) {
  if (!semiFixture || !semiFixture.done) return null;
  const winner = teamFromSide(semiFixture, winnerSide(semiFixture));
  return makeFixture({ id: "final", stage: "final", order: 23, label: "Final", a: bye, b: winner });
}

// One call that answers: what's the standing, what can be generated next,
// which already-generated later matches are now stale (because an earlier
// score changed who plays), and which decisions only the admin can make.
export function deriveBracket(fixtures, overrides = {}) {
  const standings = computeStandings(fixtures, overrides);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const existingKo = ["ko-1", "ko-2", "ko-3"].map((id) => byId.get(id)).filter(Boolean);
  const existingSemi = byId.get("semi") || null;
  const existingFinal = byId.get("final") || null;
  const expectedKo = deriveKnockout(standings);
  const koValid = !!expectedKo && existingKo.length === 3 && expectedKo.every((e, i) => samePair(e, existingKo[i]));

  const staleIds = [];
  let semiInfo = null, expectedSemi = null, expectedFinal = null;
  let semiValid = false, finalValid = false;

  if (existingKo.length > 0 && !koValid) {
    existingKo.forEach((f) => staleIds.push(f.id));
    if (existingSemi) staleIds.push("semi");
    if (existingFinal) staleIds.push("final");
  } else if (koValid) {
    semiInfo = deriveSemiAndBye(existingKo, overrides);
    expectedSemi = semiInfo && !semiInfo.needsDecision ? semiInfo.semi : null;
    semiValid = !!expectedSemi && !!existingSemi && samePair(expectedSemi, existingSemi);
    if (existingSemi && !semiValid) {
      staleIds.push("semi");
      if (existingFinal) staleIds.push("final");
    } else if (semiValid) {
      expectedFinal = deriveFinal(existingSemi, semiInfo.bye);
      finalValid = !!expectedFinal && !!existingFinal && samePair(expectedFinal, existingFinal);
      if (existingFinal && !finalValid) staleIds.push("final");
    }
  } else {
    if (existingSemi) staleIds.push("semi");
    if (existingFinal) staleIds.push("final");
  }

  let next = null;
  if (existingKo.length === 0 && expectedKo) next = { stage: "ko", fixtures: expectedKo };
  else if (koValid && !existingSemi && expectedSemi) next = { stage: "semi", fixtures: [expectedSemi] };
  else if (semiValid && !existingFinal && expectedFinal) next = { stage: "final", fixtures: [expectedFinal] };

  const needs = [];
  GROUPS.forEach((g) => { if (standings[g].unresolved) needs.push({ type: "group", group: g, rows: standings[g].rows }); });
  if (koValid && semiInfo && semiInfo.needsDecision) needs.push({ type: "bye", candidates: semiInfo.candidates });

  let placement = null;
  if (finalValid && existingFinal.done) {
    const w = winnerSide(existingFinal);
    const sw = winnerSide(existingSemi);
    placement = {
      champion: teamFromSide(existingFinal, w),
      runnerUp: teamFromSide(existingFinal, w === 1 ? 2 : 1),
      third: teamFromSide(existingSemi, sw === 1 ? 2 : 1)
    };
  }
  return { standings, next, staleIds, needs, placement, bye: semiInfo && semiInfo.bye ? semiInfo.bye : null };
}

// ------------------------------------------------------- points (pure part)
// Plays every match in order, each one using the ratings left by the previous
// one (exactly how recording matches one by one works today).
export function computeTournamentPoints(fixtures, playersById) {
  const errors = [];
  const ordered = [...fixtures].sort((a, b) => a.order - b.order);
  const counts = { group: 0, ko: 0, semi: 0, final: 0 };
  ordered.forEach((f) => { if (counts[f.stage] !== undefined) counts[f.stage]++; });
  Object.keys(EXPECTED_FIXTURES).forEach((s) => {
    if (counts[s] !== EXPECTED_FIXTURES[s]) errors.push(`The bracket isn't complete yet (${s}: ${counts[s]} of ${EXPECTED_FIXTURES[s]} matches generated).`);
  });
  ordered.forEach((f) => {
    const ok = f.done && Number.isInteger(f.score1) && Number.isInteger(f.score2) && f.score1 >= 0 && f.score2 >= 0 && f.score1 !== f.score2;
    if (!ok) errors.push(`${f.label} (#${f.order}) doesn't have a valid result yet.`);
  });
  const ids = fixturePlayerIds(ordered);
  if (ids.length !== 24) errors.push(`Expected 24 different players but found ${ids.length}.`);
  const state = new Map();
  ids.forEach((id) => {
    const p = playersById.get(id);
    if (!p) { errors.push(`A player in this tournament no longer exists (${id}).`); return; }
    if (!isRanked(p)) { errors.push(`${p.name || id} has no rank yet — give them a rank first.`); return; }
    state.set(id, {
      id, name: p.name || "—",
      rating: p.ratingPoints, matches: p.matchesPlayed ?? 0, wins: p.wins ?? 0, losses: p.losses ?? 0,
      start: { rating: p.ratingPoints, matchesPlayed: p.matchesPlayed ?? 0, wins: p.wins ?? 0, losses: p.losses ?? 0 }
    });
  });
  if (errors.length) return { ok: false, errors };

  const history = [];
  for (const f of ordered) {
    const toPlayer = (id) => { const s = state.get(id); return { id: s.id, ratingPoints: s.rating, matchesPlayed: s.matches }; };
    const results = computeMatchPointChanges(f.team1Players.map(toPlayer), f.team2Players.map(toPlayer), f.score1, f.score2);
    results.forEach((r) => {
      const s = state.get(r.playerId);
      history.push({ fixtureId: f.id, order: f.order, ...r });
      s.rating = r.ratingAfter; s.matches += 1;
      if (r.won) s.wins += 1; else s.losses += 1;
    });
  }
  const players = [...state.values()].map((s) => ({
    id: s.id, name: s.name, before: s.start,
    after: { rating: s.rating, matchesPlayed: s.matches, wins: s.wins, losses: s.losses }
  }));
  return { ok: true, errors: [], players, history, matches: ordered };
}

// -------------------------------------------------------- Firestore helpers
const fixturesCol = (tid) => collection(db, "tournaments", tid, "fixtures");

export async function fetchFixtures(tid) {
  const snap = await getDocs(fixturesCol(tid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
}

export async function createFixtures(tid, fixtures) {
  const batch = writeBatch(db);
  fixtures.forEach((f) => {
    const { id, ...data } = f;
    batch.set(doc(db, "tournaments", tid, "fixtures", id), { ...data, createdAt: serverTimestamp() });
  });
  await batch.commit();
}

export async function saveFixtureScore(tid, fixtureId, score1, score2) {
  await updateDoc(doc(db, "tournaments", tid, "fixtures", fixtureId), { score1, score2, done: true });
}

export async function deleteFixtures(tid, ids) {
  if (!ids.length) return;
  const batch = writeBatch(db);
  ids.forEach((id) => batch.delete(doc(db, "tournaments", tid, "fixtures", id)));
  await batch.commit();
}

export async function saveOverrides(tid, overrides) {
  await updateDoc(doc(db, "tournaments", tid), { bracketOverrides: overrides });
}

const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6;

// Writes the points for the WHOLE tournament in one transaction: either every
// player, match and history entry is saved, or nothing is. The players are
// re-read inside the transaction, so it can never use stale ratings.
export async function applyTournamentPoints(tid, fixtures) {
  const tRef = doc(db, "tournaments", tid);
  const ids = fixturePlayerIds(fixtures);
  const finalizeId = `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseMs = Date.now();

  return runTransaction(db, async (tx) => {
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists()) throw new Error("Tournament not found.");
    if (tSnap.data().pointsApplied) throw new Error("Points were already calculated for this tournament.");
    const snaps = await Promise.all(ids.map((id) => tx.get(doc(db, "players", id))));
    const playersById = new Map();
    snaps.forEach((s, i) => { if (s.exists()) playersById.set(ids[i], { id: ids[i], ...s.data() }); });

    const calc = computeTournamentPoints(fixtures, playersById);
    if (!calc.ok) throw Object.assign(new Error(calc.errors.join("\n")), { code: "validation", errors: calc.errors });

    const matchIds = [];
    const historyIds = [];
    const matchRefByFixture = new Map();
    calc.matches.forEach((f) => {
      const ref = doc(collection(db, "matches"));
      matchRefByFixture.set(f.id, ref);
      matchIds.push(ref.id);
      tx.set(ref, {
        tournamentId: tid, round: f.label, team1: f.team1Players, team2: f.team2Players,
        team1Games: f.score1, team2Games: f.score2, fixtureId: f.id, finalizeId,
        createdAt: Timestamp.fromMillis(baseMs + f.order * 1000)
      });
    });
    calc.history.forEach((h) => {
      const ref = doc(collection(db, "ratingHistory"));
      historyIds.push(ref.id);
      tx.set(ref, {
        playerId: h.playerId, matchId: matchRefByFixture.get(h.fixtureId).id, tournamentId: tid, finalizeId,
        ratingBefore: h.ratingBefore, opponentAvgRating: h.opponentAvg, expectedScore: h.expectedScore,
        actualResult: h.actualResult, marginMultiplier: h.marginMultiplier, kFactor: h.kFactor,
        pointsChange: h.pointsChange, ratingAfter: h.ratingAfter,
        createdAt: Timestamp.fromMillis(baseMs + h.order * 1000)
      });
    });
    const summaryPlayers = {};
    calc.players.forEach((p) => {
      tx.update(doc(db, "players", p.id), {
        ratingPoints: p.after.rating, matchesPlayed: p.after.matchesPlayed, wins: p.after.wins, losses: p.after.losses
      });
      summaryPlayers[p.id] = { name: p.name, before: p.before, after: p.after };
    });
    tx.update(tRef, {
      pointsApplied: true, appliedFinalizeId: finalizeId, appliedAt: serverTimestamp(),
      appliedMatchIds: matchIds, appliedHistoryIds: historyIds, appliedSummary: summaryPlayers
    });
    return { finalizeId, players: calc.players, matchCount: matchIds.length, historyCount: historyIds.length };
  });
}

// Re-reads everything the calculation wrote and compares it to what was
// supposed to be written.
export async function verifyApplied(tid) {
  const tSnap = await getDoc(doc(db, "tournaments", tid));
  const t = tSnap.exists() ? tSnap.data() : null;
  if (!t || !t.pointsApplied) return { ok: false, notApplied: true, mismatches: [], checked: 0, total: 0 };
  const entries = Object.entries(t.appliedSummary || {});
  const mismatches = [];
  for (const [id, s] of entries) {
    const snap = await getDoc(doc(db, "players", id));
    if (!snap.exists()) { mismatches.push(`${s.name}: player not found`); continue; }
    const d = snap.data();
    const a = s.after;
    if (!near(d.ratingPoints, a.rating) || d.matchesPlayed !== a.matchesPlayed || d.wins !== a.wins || d.losses !== a.losses) {
      mismatches.push(`${s.name}: expected ${Math.round(a.rating)} pts / ${a.matchesPlayed} matches, found ${Math.round(d.ratingPoints ?? 0)} pts / ${d.matchesPlayed ?? 0} matches`);
    }
  }
  const [hSnap, mSnap] = await Promise.all([
    getDocs(query(collection(db, "ratingHistory"), where("finalizeId", "==", t.appliedFinalizeId))),
    getDocs(query(collection(db, "matches"), where("finalizeId", "==", t.appliedFinalizeId)))
  ]);
  const expectedHistory = (t.appliedHistoryIds || []).length;
  const expectedMatches = (t.appliedMatchIds || []).length;
  if (hSnap.size !== expectedHistory) mismatches.push(`History entries: expected ${expectedHistory}, found ${hSnap.size}`);
  if (mSnap.size !== expectedMatches) mismatches.push(`Matches: expected ${expectedMatches}, found ${mSnap.size}`);
  return {
    ok: mismatches.length === 0, checked: entries.length - mismatches.filter((m) => !m.startsWith("History") && !m.startsWith("Matches")).length,
    total: entries.length, mismatches, historyCount: hSnap.size, matchCount: mSnap.size
  };
}

// Undoes a calculation — only if nobody's numbers changed since (no later
// matches, no manual rank edit), otherwise it refuses and changes nothing.
export async function revertTournamentPoints(tid) {
  const tRef = doc(db, "tournaments", tid);
  return runTransaction(db, async (tx) => {
    const tSnap = await tx.get(tRef);
    const t = tSnap.exists() ? tSnap.data() : null;
    if (!t || !t.pointsApplied) throw new Error("There are no calculated points to undo for this tournament.");
    const entries = Object.entries(t.appliedSummary || {});
    const snaps = await Promise.all(entries.map(([id]) => tx.get(doc(db, "players", id))));
    const problems = [];
    entries.forEach(([id, s], i) => {
      const snap = snaps[i];
      if (!snap.exists()) { problems.push(`${s.name}: the player was deleted`); return; }
      const d = snap.data();
      const a = s.after;
      if (!near(d.ratingPoints, a.rating) || d.matchesPlayed !== a.matchesPlayed || d.wins !== a.wins || d.losses !== a.losses) {
        problems.push(`${s.name}: points or matches changed after the calculation, so it can't be undone safely`);
      }
    });
    if (problems.length) throw Object.assign(new Error(problems.join("\n")), { code: "validation", errors: problems });

    entries.forEach(([id, s]) => {
      tx.update(doc(db, "players", id), {
        ratingPoints: s.before.rating, matchesPlayed: s.before.matchesPlayed, wins: s.before.wins, losses: s.before.losses
      });
    });
    (t.appliedMatchIds || []).forEach((mid) => tx.delete(doc(db, "matches", mid)));
    (t.appliedHistoryIds || []).forEach((hid) => tx.delete(doc(db, "ratingHistory", hid)));
    tx.update(tRef, {
      pointsApplied: false, appliedFinalizeId: null, appliedAt: null,
      appliedMatchIds: null, appliedHistoryIds: null, appliedSummary: null
    });
    return { restored: entries.length };
  });
}
