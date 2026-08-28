// Shared team-management helpers for a fixed-size bracket (numbered team slots).
// Used by both admin.js (Tournament Manager grid) and app.js (player self-service
// register / add-partner), so the two surfaces can never drift out of sync —
// they're reading and writing through the exact same functions.

import {
  db, collection, doc, getDoc, getDocs, updateDoc, deleteDoc, addDoc,
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
// as player1 with an open player2 slot. If the tournament is full, they go on
// the waiting list instead (still counted in participantIds). Safe to call
// twice (idempotent) if they already have a team.
export async function registerPlayer(tournamentId, playerId, totalTeams) {
  const teams = await fetchTeams(tournamentId);
  const already = findTeamOf(teams, playerId);
  await updateDoc(doc(db, "tournaments", tournamentId), { participantIds: arrayUnion(playerId) });
  if (already) return { ...already, waiting: false };

  const used = new Set(teams.map((t) => t.teamNumber).filter(Boolean));
  let nextNum = null;
  for (let n = 1; n <= (totalTeams || 12); n++) {
    if (!used.has(n)) { nextNum = n; break; }
  }
  if (!nextNum) {
    await updateDoc(doc(db, "tournaments", tournamentId), { waitingList: arrayUnion(playerId) });
    return { waiting: true };
  }
  const ref = await addDoc(collection(db, "tournaments", tournamentId, "teams"), {
    teamNumber: nextNum, player1Id: playerId, player2Id: null, group: null, createdAt: serverTimestamp()
  });
  return { id: ref.id, teamNumber: nextNum, player1Id: playerId, player2Id: null, group: null, waiting: false };
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
export async function unregisterPlayer(tournamentId, playerId, founderChoice) {
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
      await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), { player1Id: nextId || null });
    } else {
      await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), {
        player1Id: myTeam.player2Id,
        player2Id: null
      });
    }
    return;
  }

  if (myTeam.player1Id === playerId) {
    // solo founder leaving — the whole number frees up for the waiting list
    await deleteDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id));
    await claimFreeNumberFromWaitlist(tournamentId);
    return;
  }

  // partner (player2) leaving — just open their slot, no waitlist promotion
  await updateDoc(doc(db, "tournaments", tournamentId, "teams", myTeam.id), { player2Id: null });
}

async function popWaitlist(tournamentId) {
  const tSnap = await getDoc(doc(db, "tournaments", tournamentId));
  const waitingList = tSnap.exists() ? (tSnap.data().waitingList || []) : [];
  if (waitingList.length === 0) return null;
  const nextId = waitingList[0];
  await updateDoc(doc(db, "tournaments", tournamentId), { waitingList: arrayRemove(nextId) });
  return nextId;
}

async function claimFreeNumberFromWaitlist(tournamentId) {
  const nextId = await popWaitlist(tournamentId);
  if (!nextId) return;

  const tSnap = await getDoc(doc(db, "tournaments", tournamentId));
  const totalTeams = tSnap.exists() ? (tSnap.data().totalTeams || 12) : 12;
  const teams = await fetchTeams(tournamentId);
  const used = new Set(teams.map((t) => t.teamNumber).filter(Boolean));
  let num = null;
  for (let n = 1; n <= totalTeams; n++) {
    if (!used.has(n)) { num = n; break; }
  }
  if (num == null) {
    // nothing actually free (shouldn't normally happen) — put them back
    await updateDoc(doc(db, "tournaments", tournamentId), { waitingList: arrayUnion(nextId) });
    return;
  }
  await addDoc(collection(db, "tournaments", tournamentId, "teams"), {
    teamNumber: num, player1Id: nextId, player2Id: null, group: null, createdAt: serverTimestamp()
  });
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
