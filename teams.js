// Shared team-management helpers for a fixed-size bracket (numbered team slots).
// Used by both admin.js (Tournament Manager grid) and app.js (player self-service
// register / add-partner), so the two surfaces can never drift out of sync —
// they're reading and writing through the exact same functions.

import {
  db, collection, doc, getDocs, updateDoc, deleteDoc, addDoc,
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

// Player registers themselves: claims the next free team number (1..totalTeams)
// as player1 with an open player2 slot. Safe to call twice (idempotent).
export async function registerPlayer(tournamentId, playerId, totalTeams) {
  const teams = await fetchTeams(tournamentId);
  const already = findTeamOf(teams, playerId);
  await updateDoc(doc(db, "tournaments", tournamentId), { participantIds: arrayUnion(playerId) });
  if (already) return already;

  const used = new Set(teams.map((t) => t.teamNumber).filter(Boolean));
  let nextNum = null;
  for (let n = 1; n <= (totalTeams || 12); n++) {
    if (!used.has(n)) { nextNum = n; break; }
  }
  if (!nextNum) {
    const err = new Error("Tournament is full");
    err.code = "FULL";
    throw err;
  }
  const ref = await addDoc(collection(db, "tournaments", tournamentId, "teams"), {
    teamNumber: nextNum, player1Id: playerId, player2Id: null, group: null, createdAt: serverTimestamp()
  });
  return { id: ref.id, teamNumber: nextNum, player1Id: playerId, player2Id: null, group: null };
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

// Full unregister: removes from the team slot (same rules as removeFromSlot)
// AND takes them out of participantIds.
export async function unregisterPlayer(tournamentId, playerId) {
  await removeFromSlot(tournamentId, playerId);
  await updateDoc(doc(db, "tournaments", tournamentId), { participantIds: arrayRemove(playerId) });
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
    await deleteDoc(doc(db, "tournaments", tournamentId, "teams", elsewhere.id));
  }
  await updateDoc(doc(db, "tournaments", tournamentId), { participantIds: arrayUnion(partnerId) });
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), { player2Id: partnerId });
}

// Admin-only: place a specific player directly into team #teamNumber's given
// slot ('player1' | 'player2'), pulling them out of wherever they currently
// are first (if anywhere), and registering them if they weren't already.
export async function assignToSlot(tournamentId, teamNumber, slot, playerId) {
  await removeFromSlot(tournamentId, playerId); // no-op if not on a team yet
  await updateDoc(doc(db, "tournaments", tournamentId), { participantIds: arrayUnion(playerId) });

  const teams = await fetchTeams(tournamentId);
  const existing = teams.find((t) => t.teamNumber === teamNumber);
  if (!existing) {
    await addDoc(collection(db, "tournaments", tournamentId, "teams"), {
      teamNumber,
      player1Id: slot === "player1" ? playerId : null,
      player2Id: slot === "player2" ? playerId : null,
      group: null,
      createdAt: serverTimestamp()
    });
    return;
  }
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", existing.id), { [slot]: playerId });
}

export async function setTeamGroup(tournamentId, teamId, group) {
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", teamId), { group: group || null });
}
