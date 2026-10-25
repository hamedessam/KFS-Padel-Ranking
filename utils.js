// Shared helpers: password hashing (SHA-256 + per-user salt) and code/password generation

export function randomSalt(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(salt + ":" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Generates a readable random password like "PDL-7K2M9Q" style but without ambiguous chars (0/O, 1/I/L)
export function generatePassword(len = 8) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// Generates a player code like KFS-461 given a running sequence number
export function playerCodeFromSeq(seq) {
  return `KFS-${String(seq).padStart(3, "0")}`;
}

import { getLang } from "./i18n.js";

// Tier is always derived from points — never chosen manually — so nobody
// can dispute "why did you put me in Silver". The math decides, not a person.
//
// 5 ranks of 500 points each, every rank starting on a multiple of 500:
// Bronze 0-499, Silver 500-999, Gold 1000-1499, Diamond 1500-1999 (so exactly
// 1000 is Gold 1), each split into 3 tiers of ~167 points. A HIGHER number is a
// HIGHER tier (Gold 3 is above Gold 1). Elite is 2000+ with no ceiling and no
// sub-tiers.
//
// `min` = the first point of the tier (this is what decides the tier).
// `start` = where a player is PLACED when the admin gives them that tier: the
// middle of the tier, so one lost match can't demote them straight away.
// (Elite has no ceiling, so it gets a small cushion above 2000.)
const TIER_THRESHOLDS = [
  { min: 2000, tier: "elite", start: 2050 },
  { min: 1834, tier: "diamond_3", start: 1917 },
  { min: 1667, tier: "diamond_2", start: 1750 },
  { min: 1500, tier: "diamond_1", start: 1583 },
  { min: 1334, tier: "gold_3", start: 1417 },
  { min: 1167, tier: "gold_2", start: 1250 },
  { min: 1000, tier: "gold_1", start: 1083 },
  { min: 834, tier: "silver_3", start: 917 },
  { min: 667, tier: "silver_2", start: 750 },
  { min: 500, tier: "silver_1", start: 583 },
  { min: 334, tier: "bronze_3", start: 417 },
  { min: 167, tier: "bronze_2", start: 250 },
  { min: -Infinity, tier: "bronze_1", start: 83 }
];

export function tierFromPoints(points) {
  const p = Math.round(points ?? 0);
  for (const t of TIER_THRESHOLDS) {
    if (p >= t.min) return t.tier;
  }
  return "bronze_1";
}

// A player with no rating yet (ratingPoints null/absent) is "unranked".
export function isRanked(player) {
  return player.ratingPoints !== null && player.ratingPoints !== undefined;
}

// Every tier (lowest -> highest) with its real range and its starting points,
// read straight from TIER_THRESHOLDS so it can never drift from the real
// boundaries. `max` is null for Elite (no ceiling).
export function tierStartOptions() {
  const asc = [...TIER_THRESHOLDS].reverse();
  return asc.map((t, i) => ({
    tier: t.tier,
    points: t.start,
    min: Number.isFinite(t.min) ? t.min : 0,
    max: i + 1 < asc.length ? asc[i + 1].min - 1 : null
  }));
}

const FAMILY_NAMES = {
  ar: { bronze: "برونزي", silver: "فضي", gold: "ذهبي", diamond: "دايموند", elite: "إيليت" },
  en: { bronze: "Bronze", silver: "Silver", gold: "Gold", diamond: "Diamond", elite: "Elite" }
};

// "silver" -> "Silver" / "فضي" (no tier number) — for tournament rank badges
export function rankFamilyLabel(family) {
  const names = FAMILY_NAMES[getLang()] || FAMILY_NAMES.en;
  return names[family] || family;
}

export function tierMeta(tierId) {
  // tierId format: "silver_3", "gold_1", "diamond_2" etc. — or just "elite"
  // (no sub-tiers).
  const [family, level] = (tierId || "bronze_1").split("_");
  const familyNames = FAMILY_NAMES[getLang()] || FAMILY_NAMES.en;
  return {
    family,
    level: level || "E", // text shown inside the shield badge
    displayName: `${familyNames[family] || family} ${level || ""}`.trim(),
    cssClass: family
  };
}

// ---------------- tournament rank rules ----------------
// A tournament can be limited to one rank (bronze / silver / gold / diamond /
// elite). No rank on the tournament = open to everyone (how every older
// tournament behaves).
//   - registering a team of your own: players OF that rank only
//   - being picked as a partner / sending a join request: players of that
//     rank, or of the rank directly below it (Bronze is the bottom: Bronze
//     tournaments are Bronze only)
// Players with no rank yet can't take part in a ranked tournament.
export const RANK_FAMILIES = ["bronze", "silver", "gold", "diamond", "elite"];

export function playerRankFamily(player) {
  if (!isRanked(player)) return null;
  return tierFromPoints(player.ratingPoints).split("_")[0];
}

export function rankBelow(family) {
  const i = RANK_FAMILIES.indexOf(family);
  return i > 0 ? RANK_FAMILIES[i - 1] : null;
}

// The ranks a tournament is open to, as an array in ladder order. New
// tournaments store `ranks: [...]`; older ones only have a single `rank`
// string (still understood). Empty array = open to everyone.
export function tournamentRanks(tournament) {
  if (!tournament) return [];
  const list = Array.isArray(tournament.ranks)
    ? tournament.ranks
    : (tournament.rank ? [tournament.rank] : []);
  return RANK_FAMILIES.filter((f) => list.includes(f));
}

// Founding a team and being a partner follow the same rule now: the player's
// rank must be one of the tournament's selected ranks (no "one rank below"
// extra any more). Open tournaments (no ranks) = everyone.
export function canFoundTeam(player, tournament) {
  const ranks = tournamentRanks(tournament);
  if (ranks.length === 0) return true;
  const f = playerRankFamily(player);
  return f !== null && ranks.includes(f);
}

export function canBePartner(player, tournament) {
  return canFoundTeam(player, tournament);
}

// Renders inner content for an avatar container (a div/span already carrying
// the .avatar or .lb-avatar class): either the player's uploaded photo or a
// fallback initial letter. Caller just does `container.innerHTML = avatarHtml(player)`.
export function avatarHtml(player) {
  if (player.avatarUrl) {
    return `<img src="${player.avatarUrl}" alt="">`;
  }
  return (player.name || "?").trim().charAt(0).toUpperCase();
}

// First 20 registered players (by sequential player code) are Founding Members.
export function isFoundingMember(player) {
  const codeNum = parseInt((player.playerCode || "").replace(/\D/g, ""), 10);
  return Boolean(codeNum) && codeNum <= 20;
}

// ---------------- rating engine (ELO + margin-of-victory) ----------------
// K-factor: faster movement for provisional players (<20 rated matches) so
// tiers separate quickly; steadier for established players so one match
// against a newcomer doesn't swing them wildly.
export function kFactorFor(matchesPlayed) {
  return (matchesPlayed ?? 0) < 20 ? 40 : 20;
}

// 6-0 (blowout) hits harder than 7-6 (tiebreak squeaker). Capped so a freak
// scoreline (like a 10-2 super-tiebreak) can't blow the multiplier out.
export function marginMultiplier(gamesA, gamesB) {
  const diff = Math.abs(gamesA - gamesB);
  return Math.min(0.5 + diff / 6, 1.6);
}

function avgRating(players) {
  return players.reduce((sum, p) => sum + (p.ratingPoints ?? 1000), 0) / players.length;
}

// team1/team2: arrays of exactly 2 player objects {id, ratingPoints, matchesPlayed}.
// Returns one result per player (4 total), each computed individually against
// the OPPONENT TEAM AVERAGE — so a weaker player on the winning team gains more
// than their stronger teammate, and vice versa on a loss.
export function computeMatchPointChanges(team1, team2, team1Games, team2Games) {
  const team1Avg = avgRating(team1);
  const team2Avg = avgRating(team2);
  const team1Won = team1Games > team2Games;
  const multiplier = marginMultiplier(team1Games, team2Games);

  const entries = [
    ...team1.map((p) => ({ player: p, opponentAvg: team2Avg, won: team1Won })),
    ...team2.map((p) => ({ player: p, opponentAvg: team1Avg, won: !team1Won }))
  ];

  return entries.map(({ player, opponentAvg, won }) => {
    const ratingBefore = player.ratingPoints ?? 1000;
    const expectedScore = 1 / (1 + Math.pow(10, (opponentAvg - ratingBefore) / 400));
    const actualResult = won ? 1 : 0;
    const k = kFactorFor(player.matchesPlayed);
    // Ratings never go below 0 (Bronze starts at 0), so a loss can't push
    // anyone negative — and pointsChange reflects what was really applied.
    const ratingAfter = Math.max(0, ratingBefore + k * multiplier * (actualResult - expectedScore));
    const pointsChange = ratingAfter - ratingBefore;
    return {
      playerId: player.id,
      ratingBefore,
      ratingAfter,
      opponentAvg,
      expectedScore,
      actualResult,
      marginMultiplier: multiplier,
      kFactor: k,
      pointsChange,
      won
    };
  });
}
