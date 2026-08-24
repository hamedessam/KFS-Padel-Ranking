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
// Everyone starts at 1000 points, which lands in Silver 3 by design.
const TIER_THRESHOLDS = [
  { min: 1500, tier: "gold_1" },
  { min: 1400, tier: "gold_2" },
  { min: 1300, tier: "gold_3" },
  { min: 1200, tier: "silver_1" },
  { min: 1100, tier: "silver_2" },
  { min: 1000, tier: "silver_3" },
  { min: 900, tier: "bronze_1" },
  { min: 800, tier: "bronze_2" },
  { min: -Infinity, tier: "bronze_3" }
];

export function tierFromPoints(points) {
  const p = Math.round(points ?? 1000);
  for (const t of TIER_THRESHOLDS) {
    if (p >= t.min) return t.tier;
  }
  return "bronze_3";
}

export function tierMeta(tierId) {
  // tierId format: "silver_3", "gold_1", "bronze_2" etc.
  const [family, level] = (tierId || "bronze_3").split("_");
  const names = {
    ar: { bronze: "برونزي", silver: "فضي", gold: "ذهبي" },
    en: { bronze: "Bronze", silver: "Silver", gold: "Gold" }
  };
  const lang = getLang();
  const familyNames = names[lang] || names.en;
  return {
    family,
    level,
    displayName: `${familyNames[family] || family} ${level || ""}`.trim(),
    cssClass: family
  };
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
    const pointsChange = k * multiplier * (actualResult - expectedScore);
    return {
      playerId: player.id,
      ratingBefore,
      ratingAfter: ratingBefore + pointsChange,
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
