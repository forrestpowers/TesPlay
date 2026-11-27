#!/usr/bin/env node
// Sets a new password for a TesPlay account, including the owner's, from the
// server itself. Run it where TesPlay's data lives, for example in Docker:
//
//   docker exec -it tesplay node scripts/reset-password.mjs <username or email>
//
// A strong password is generated and printed once. To choose it yourself,
// pipe it in instead:  printf '%s' 'new password' | docker exec -i tesplay \
//   node scripts/reset-password.mjs <username or email> --stdin
// The account is signed out on every device.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { hashPassword, validatePassword } from "../server/security.js";

const [account, option] = process.argv.slice(2);
if (!account || (option && option !== "--stdin")) {
  console.error("Usage: node scripts/reset-password.mjs <username or email> [--stdin]");
  process.exit(2);
}
const dbPath = resolve(process.env.DATA_DIR || "./data", "aperture.sqlite");
if (!existsSync(dbPath)) {
  console.error(`No TesPlay database at ${dbPath}. Set DATA_DIR to TesPlay's data folder.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
// The server may be running; wait for its writes instead of failing.
db.exec("PRAGMA busy_timeout = 5000");
const user = db.prepare("SELECT id, role, name, username, email, disabled FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE").get(account, account);
if (!user) {
  const known = db.prepare("SELECT username, role FROM users ORDER BY created_at").all();
  console.error(`No account "${account}". Accounts: ${known.map((u) => `${u.username} (${u.role})`).join(", ") || "none"}`);
  process.exit(1);
}

let password;
if (option === "--stdin") {
  const parts = [];
  for await (const chunk of process.stdin) parts.push(chunk);
  password = Buffer.concat(parts).toString("utf8").replace(/\r?\n$/, "");
} else {
  // 120 random bits as 20 URL-safe characters.
  password = randomBytes(15).toString("base64url");
}
try { validatePassword(password); }
catch (error) { console.error(error.message); process.exit(1); }

const passwordHash = await hashPassword(password);
db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
const signedOut = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
db.close();

console.log(`Password updated for ${user.name} (${user.username}, ${user.role}). Signed out of ${signedOut} session${signedOut === 1 ? "" : "s"}.`);
if (option !== "--stdin") console.log(`New password: ${password}\nStore it in your password manager; it is not shown again.`);
if (user.disabled) console.log("Note: this account is disabled. The owner can re-enable it in Settings → Household accounts.");
