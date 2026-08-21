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

export function tierMeta(tierId) {
  // tierId format: "silver_3", "gold_1", "bronze_2" etc.
  const [family, level] = (tierId || "bronze_3").split("_");
  const names = { bronze: "Bronze", silver: "Silver", gold: "Gold" };
  return {
    family,
    level,
    displayName: `${names[family] || family} ${level || ""}`.trim(),
    cssClass: family
  };
}
