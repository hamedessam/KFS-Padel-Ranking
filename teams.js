// Shared team-management helpers for a fixed-size bracket (numbered team slots).
// Used by both admin.js (Tournament Manager grid) and app.js (player self-service
// register / add-partner), so the two surfaces can never drift out of sync —
// they're reading and writing through the exact same functions.

import {
  db, collection, doc, getDoc, getDocs, updateDoc, deleteDoc, addDoc, runTransaction, writeBatch,
  arrayUnion, arrayRemove, serverTimestamp
} from "./firebase-config.js";

export async function fetchTeams(tournamentId) {
  const snap = await getDocs(collection(db, "tournaments", tournamentId, "teams"));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.teamNumber || 99) - (b.teamNumber || 99));
}

export function findTeamOf(teams, playerId) {
  return teams.find((t) => t.player1Id === playerId || t.player2Id === playerId) || null;
}

// ---------------- race-safe team-number claiming ----------------
// New teams get a deterministic document id ("slot-<number>") and are created
// inside a transaction that first checks the id doesn't exist yet. So even if
// 50 players tap "Register a team" in the same second, Firestore itself
// guarantees only ONE of them gets any given number — the others simply move
// on to the next free number (or the waiting list). Older teams that were
// created before this change keep their random ids and keep working as-is.
const slotDocId = (n) => `slot-${n}`;

// Small retry with jitter for transient failures (busy server, contention).
async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err && err.code === "permission-denied") throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1) + Math.random() * 400));
    }
  }
  throw lastErr;
}

// Creates team #teamNumber only if nobody has taken it yet. Returns the new
// team's doc id, or null if the number was already taken.
async function tryCreateSlotTeam(tournamentId, teamNumber, players) {
  const ref = doc(db, "tournaments", tournamentId, "teams", slotDocId(teamNumber));
  const tRef = doc(db, "tournaments", tournamentId);
  const joiner = players.player1Id || players.player2Id;
  return withRetry(() => runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return null;
    tx.set(ref, {
      teamNumber,
      player1Id: players.player1Id ?? null,
      player2Id: players.player2Id ?? null,
      group: null,
      createdAt: serverTimestamp()
    });
    // Same transaction: the team and the player's "registered" mark are saved
    // together or not at all, so an interrupted request can never leave
    // someone registered without a team.
    if (joiner) tx.update(tRef, { participantIds: arrayUnion(joiner), waitingList: arrayRemove(joiner) });
    return ref.id;
  }));
}

// A team document that exists but has nobody in it (both slots empty) still
// "holds" its number in the grid. Re-use it instead of treating the number as
// taken. Done in a transaction that re-checks it is still empty.
async function tryClaimEmptyTeam(tournamentId, teamDocId, players) {
  const ref = doc(db, "tournaments", tournamentId, "teams", teamDocId);
  const tRef = doc(db, "tournaments", tournamentId);
  const joiner = players.player1Id || players.player2Id;
  return withRetry(() => runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const d = snap.data();
    if (d.player1Id || d.player2Id) return null;
    tx.update(ref, {
      player1Id: players.player1Id ?? null,
      player2Id: players.player2Id ?? null,
      joinRequests: []
    });
    if (joiner) tx.update(tRef, { participantIds: arrayUnion(joiner), waitingList: arrayRemove(joiner) });
    return ref.id;
  }));
}

// Which team numbers (1..totalTeams) are really free, given a recent fetch?
// A number is free if no team has it, or the team that has it is completely empty.
function freeNumbers(teams, totalTeams) {
  const byNum = new Map();
  teams.forEach((tm) => {
    if (!tm.teamNumber) return;
    if (!byNum.has(tm.teamNumber)) byNum.set(tm.teamNumber, []);
    byNum.get(tm.teamNumber).push(tm);
  });
  const out = [];
  for (let n = 1; n <= totalTeams; n++) {
    const list = byNum.get(n) || [];
    if (list.some((tm) => tm.player1Id || tm.player2Id)) continue; // occupied
    out.push({ number: n, emptyTeam: list[0] || null });
  }
  return out;
}

// Walks the free numbers from lowest to highest and claims the first one that
// is genuinely still free (race-safe).
async function claimLowestFreeSlot(tournamentId, totalTeams, teams, players) {
  for (const f of freeNumbers(teams, totalTeams)) {
    if (f.emptyTeam) {
      const id = await tryClaimEmptyTeam(tournamentId, f.emptyTeam.id, players);
      if (id) return { id, teamNumber: f.number };
      continue;
    }
    const id = await tryCreateSlotTeam(tournamentId, f.number, players);
    if (id) return { id, teamNumber: f.number };
  }
  return null;
}

// Takes the first player off the waiting list. Done in a transaction so two
// devices running this at the same moment can never pull the same person.
async function popWaitlist(tournamentId) {
  const tRef = doc(db, "tournaments", tournamentId);
  return withRetry(() => runTransaction(db, async (tx) => {
    const snap = await tx.get(tRef);
    const waitingList = snap.exists() ? (snap.data().waitingList || []) : [];
    if (waitingList.length === 0) return null;
    const [nextId, ...rest] = waitingList;
    tx.update(tRef, { waitingList: rest });
    return nextId;
  }));
}

// Puts a player back at the FRONT of the waiting list (used when a promotion
// fails half-way, so nobody is lost and nobody loses their place in line).
async function putBackFirst(tournamentId, playerId) {
  const tRef = doc(db, "tournaments", tournamentId);
  await withRetry(() => runTransaction(db, async (tx) => {
    const snap = await tx.get(tRef);
    const wl = snap.exists() ? (snap.data().waitingList || []) : [];
    tx.update(tRef, { waitingList: [playerId, ...wl.filter((x) => x !== playerId)] });
  }));
}

// Moves people from the waiting list into any team NUMBER that is completely
// free (nobody on it), first in line first. It never fills a single empty
// partner slot of an existing team — a partner leaving still never pulls
// anyone from the waiting list. Returns how many players were promoted.
export async function promoteWaitlist(tournamentId) {
  const tRef = doc(db, "tournaments", tournamentId);
  let promoted = 0;
  for (let guard = 0; guard < 64; guard++) {
    const tSnap = await getDoc(tRef);
    if (!tSnap.exists()) break;
    const t = tSnap.data();
    if ((t.waitingList || []).length === 0) break;
    const totalTeams = t.totalTeams || 12;
    const teams = await fetchTeams(tournamentId);
    if (freeNumbers(teams, totalTeams).length === 0) break;

    const nextId = await popWaitlist(tournamentId);
    if (!nextId) break;
    let claimed = null;
    try {
      claimed = await claimLowestFreeSlot(tournamentId, totalTeams, teams, { player1Id: nextId, player2Id: null });
    } catch (err) {
      // never lose a waiting player because of a network hiccup
      try { await putBackFirst(tournamentId, nextId); } catch (e) { console.error(e); }
      throw err;
    }
    if (!claimed) {
      // someone else took the number first — put the player back and stop
      await putBackFirst(tournamentId, nextId);
      break;
    }
    promoted++;
  }
  return promoted;
}

// Player registers themselves: claims the next free team number (1..totalTeams)
// as player1 with an open player2 slot. If the tournament is full, they go on
// the waiting list instead (still counted in participantIds). Safe to call
// twice (idempotent) if they already have a team.
export async function registerPlayer(tournamentId, playerId, totalTeams) {
  const tRef = doc(db, "tournaments", tournamentId);
  const healRegistered = (team) =>
    withRetry(() => updateDoc(tRef, { participantIds: arrayUnion(playerId) })).then(() => ({ ...team, waiting: false }));

  let teams = await fetchTeams(tournamentId);
  let already = findTeamOf(teams, playerId);
  if (already) return healRegistered(already);

  // People already waiting get any free number first (first come, first served).
  try { await promoteWaitlist(tournamentId); } catch (e) { console.error(e); }
  teams = await fetchTeams(tournamentId);
  already = findTeamOf(teams, playerId);
  if (already) return healRegistered(already);

  // Claiming the number also marks the player as registered, in the same
  // transaction (see tryCreateSlotTeam / tryClaimEmptyTeam).
  const claimed = await claimLowestFreeSlot(tournamentId, totalTeams || 12, teams, { player1Id: playerId, player2Id: null });
  if (!claimed) {
    // full: registered + waiting list in ONE write
    await withRetry(() => updateDoc(tRef, { participantIds: arrayUnion(playerId), waitingList: arrayUnion(playerId) }));
    return { waiting: true };
  }
  return { id: claimed.id, teamNumber: claimed.teamNumber, player1Id: playerId, player2Id: null, group: null, waiting: false };
}

// Removes a player from whichever slot they're in (if any) WITHOUT touching
// participantIds. If they were player1 with a partner, the partner is promoted
// to player1 so they don't lose their spot. If they were alone, the team slot
// is freed entirely.
export async function removeFromSlot(tournamentId, playerId) {
  const teams = await fetchTeams(tournamentId);
  const myTeam = findTeamOf(teams, playerId);
  if (!myTeam) return;

  if (myTeam.player1Id === playerId) {
    if (myTeam.player2Id) {
      await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), {
        player1Id: myTeam.player2Id,
        player2Id: null
      });
    } else {
      await deleteDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id));
    }
  } else {
    await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), { player2Id: null });
  }
}

// Full unregister: removes them from participantIds/waitingList, then handles
// the vacated slot according to their role:
//  - Partner (player2) leaving: the slot just goes empty. Nobody from the
//    waiting list is pulled in automatically.
//  - Solo founder (player1, no partner) leaving: the whole team number frees
//    up and the first person on the waiting list becomes the new founder.
//  - Founder WITH a partner leaving: ambiguous on purpose — caller must pass
//    founderChoice: 'promote-partner' (partner becomes the new founder, no
//    waitlist involved — this is also the default if omitted) or
//    'fill-from-waitlist' (partner keeps their spot, someone from the waiting
//    list takes over as the new founder).
// Afterwards, any team number that is completely free is offered to the
// waiting list (see promoteWaitlist) — this also heals a number that got
// stuck free while people were waiting.
export async function unregisterPlayer(tournamentId, playerId, founderChoice) {
  await unregisterCore(tournamentId, playerId, founderChoice);
  try { await promoteWaitlist(tournamentId); } catch (e) { console.error(e); }
}

async function unregisterCore(tournamentId, playerId, founderChoice) {
  const teams = await fetchTeams(tournamentId);
  const myTeam = findTeamOf(teams, playerId);

  await updateDoc(doc(db, "tournaments", tournamentId), {
    participantIds: arrayRemove(playerId),
    waitingList: arrayRemove(playerId)
  });

  if (!myTeam) return; // was only on the waiting list — nothing else to do

  if (myTeam.player1Id === playerId && myTeam.player2Id) {
    // founder with a partner — behavior depends on their explicit choice
    if (founderChoice === "fill-from-waitlist") {
      const nextId = await popWaitlist(tournamentId);
      try {
        await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), { player1Id: nextId || null });
      } catch (err) {
        if (nextId) { try { await putBackFirst(tournamentId, nextId); } catch (e) { console.error(e); } }
        throw err;
      }
    } else {
      await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), {
        player1Id: myTeam.player2Id,
        player2Id: null
      });
    }
    return;
  }

  if (myTeam.player1Id === playerId) {
    // solo founder leaving — the whole number frees up (the waiting list is
    // offered it right after, in unregisterPlayer)
    await deleteDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id));
    return;
  }

  // partner (player2) leaving — just open their slot, no waitlist promotion
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), { player2Id: null });
}

// Fills a team's open slot with partnerId. If partnerId already has their own
// separate solo team elsewhere in this tournament, that old slot is freed up
// automatically. Throws if partnerId is already fully paired on another team.
export async function addPartner(tournamentId, teamId, partnerId) {
  const teams = await fetchTeams(tournamentId);
  const elsewhere = teams.find((t) => t.id !== teamId && (t.player1Id === partnerId || t.player2Id === partnerId));
  if (elsewhere) {
    const alreadyFull = elsewhere.player1Id && elsewhere.player2Id;
    if (alreadyFull) {
      const err = new Error("Player is already on another team");
      err.code = "ALREADY_PAIRED";
      throw err;
    }
  }
  // One batch = all-or-nothing: free their old solo slot, mark them registered
  // (and off the waiting list), and put them on this team.
  const batch = writeBatch(db);
  if (elsewhere) batch.delete(doc(db, "tournaments", tournamentId, "teams", elsewhere.id));
  batch.update(doc(db, "tournaments", tournamentId), {
    participantIds: arrayUnion(partnerId),
    waitingList: arrayRemove(partnerId)
  });
  batch.update(doc(db, "tournaments", tournamentId, "teams", teamId), { player2Id: partnerId });
  await batch.commit();
  if (elsewhere) {
    try { await promoteWaitlist(tournamentId); } catch (e) { console.error(e); } // their old number is free now
  }
}

// Admin-only: place a specific player directly into team #teamNumber's given
// slot ('player1' | 'player2'), pulling them out of wherever they currently
// are first (if anywhere), and registering them if they weren't already.
export async function assignToSlot(tournamentId, teamNumber, slot, playerId) {
  await removeFromSlot(tournamentId, playerId); // no-op if not on a team yet
  // placed on a team => no longer on the waiting list
  await updateDoc(doc(db, "tournaments", tournamentId), {
    participantIds: arrayUnion(playerId),
    waitingList: arrayRemove(playerId)
  });

  const teams = await fetchTeams(tournamentId);
  const existing = teams.find((t) => t.teamNumber === teamNumber);
  if (!existing) {
    const created = await tryCreateSlotTeam(tournamentId, teamNumber, {
      player1Id: slot === "player1" ? playerId : null,
      player2Id: slot === "player2" ? playerId : null
    });
    if (created) return;
    // A player claimed that number a moment ago — fill the slot of the team
    // that now exists instead, as long as that slot is still empty.
    const fresh = (await fetchTeams(tournamentId)).find((t) => t.teamNumber === teamNumber);
    if (!fresh || fresh[`${slot}Id`]) throw new Error("That spot was just taken — refresh and try again.");
    await updateDoc(doc(db, "tournaments", tournamentId, "teams", fresh.id), { [`${slot}Id`]: playerId });
    return;
  }
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", existing.id), { [`${slot}Id`]: playerId });
}

export async function setTeamGroup(tournamentId, teamId, group) {
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), { group: group || null });
}

// ---------------- join requests (join someone else's team, needs their OK) ----------------

// Player asks to join an existing team that has one open slot.
export async function requestToJoinTeam(tournamentId, teamId, requesterId) {
  const teams = await fetchTeams(tournamentId);
  const team = teams.find((t) => t.id === teamId);
  if (!team) throw new Error("Team not found");
  if (team.player1Id && team.player2Id) {
    const err = new Error("That team is already full");
    err.code = "FULL_TEAM";
    throw err;
  }
  if (findTeamOf(teams, requesterId)) {
    const err = new Error("You're already on a team in this tournament");
    err.code = "ALREADY_ON_TEAM";
    throw err;
  }
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), {
    joinRequests: arrayUnion(requesterId)
  });
}

export async function cancelJoinRequest(tournamentId, teamId, requesterId) {
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), {
    joinRequests: arrayRemove(requesterId)
  });
}

// Team owner accepts: fills the open slot (via addPartner, which also frees up
// the requester's old solo slot elsewhere if they had one) and clears every
// other pending request that requester had sent to other teams.
export async function acceptJoinRequest(tournamentId, teamId, requesterId) {
  await addPartner(tournamentId, teamId, requesterId);
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), { joinRequests: [] });

  const teams = await fetchTeams(tournamentId);
  await Promise.all(
    teams
      .filter((t) => t.id !== teamId && (t.joinRequests || []).includes(requesterId))
      .map((t) => updateDoc(doc(db, "tournaments", tournamentId, "teams", t.id), { joinRequests: arrayRemove(requesterId) }))
  );
}

export async function declineJoinRequest(tournamentId, teamId, requesterId) {
  await cancelJoinRequest(tournamentId, teamId, requesterId);
}

// Pure helpers over an already-fetched teams array (no extra reads).
export function getOpenTeams(teams) {
  return teams.filter((t) => (t.player1Id && !t.player2Id) || (!t.player1Id && t.player2Id));
}

export function myPendingRequestTeams(teams, myId) {
  return teams.filter((t) => (t.joinRequests || []).includes(myId));
}

export function myIncomingRequests(teams, myId) {
  return teams.filter((t) => (t.player1Id === myId || t.player2Id === myId) && (t.joinRequests || []).length > 0);
}
