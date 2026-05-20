// Secure storage for API keys (issue #6).
//
// In the Tauri app, keys live in an encrypted Stronghold vault — they are never
// written to localStorage in plaintext. The vault is unlocked with a random
// per-install password (the API key itself is never the password). See the note
// below on the inherent limitation of an app that auto-unlocks without a login.
//
// In the `bun dev` web preview there is no Tauri runtime, so we fall back to
// localStorage (clearly not secure — dev convenience only). If the vault fails
// to initialise for any reason, we fall back to an in-memory cache for the
// session so the app keeps working rather than losing the key outright.

import { isTauri } from "@tauri-apps/api/core";

const CLIENT = "verbodus";
const recordKey = (profileName) => `apikey:${profileName}`;
const webKey = (profileName) => `verbodus_apikey:${profileName}`;

const memCache = {}; // session fallback when the vault is unavailable
let vaultPromise = null; // memoised init

// NOTE: the vault password is random per install but stored locally, so an app
// that unlocks itself (no login) can always be unlocked by anyone with local
// access. Stronghold still protects the key at rest (disk images, backups,
// casual inspection) — a real improvement over plaintext localStorage — but is
// not a defence against a determined local attacker.
function getVaultPassword() {
  let pwd = localStorage.getItem("verbodus_vault_pwd");
  if (!pwd) {
    pwd = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    localStorage.setItem("verbodus_vault_pwd", pwd);
  }
  return pwd;
}

async function initVault() {
  if (vaultPromise) return vaultPromise;
  vaultPromise = (async () => {
    const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const vaultPath = await join(await appDataDir(), "verbodus.vault");
    const stronghold = await Stronghold.load(vaultPath, getVaultPassword());

    let client;
    try {
      client = await stronghold.loadClient(CLIENT);
    } catch {
      client = await stronghold.createClient(CLIENT);
    }
    return { stronghold, store: client.getStore() };
  })();
  return vaultPromise;
}

export async function getApiKey(profileName) {
  if (!profileName) return "";
  if (!isTauri()) return localStorage.getItem(webKey(profileName)) || "";
  try {
    const { store } = await initVault();
    const data = await store.get(recordKey(profileName));
    if (!data || data.length === 0) return memCache[profileName] || "";
    return new TextDecoder().decode(new Uint8Array(data));
  } catch (err) {
    console.error("Vault read failed; using session cache:", err);
    return memCache[profileName] || "";
  }
}

export async function setApiKey(profileName, key) {
  if (!profileName) return;
  memCache[profileName] = key;
  if (!isTauri()) {
    localStorage.setItem(webKey(profileName), key);
    return;
  }
  try {
    const { stronghold, store } = await initVault();
    const bytes = Array.from(new TextEncoder().encode(key));
    await store.insert(recordKey(profileName), bytes);
    await stronghold.save();
  } catch (err) {
    console.error("Vault write failed; key kept in session cache only:", err);
  }
}

export async function deleteApiKey(profileName) {
  if (!profileName) return;
  delete memCache[profileName];
  if (!isTauri()) {
    localStorage.removeItem(webKey(profileName));
    return;
  }
  try {
    const { stronghold, store } = await initVault();
    await store.remove(recordKey(profileName));
    await stronghold.save();
  } catch (err) {
    console.error("Vault delete failed:", err);
  }
}
