// End-to-End Encryption using AES-256-GCM
// Key is generated per room and shared via URL hash (never sent to server)

const ALGO = "AES-GCM";

export async function generateEncryptionKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const raw = await crypto.subtle.exportKey("raw", key);
  return uint8ToBase64url(new Uint8Array(raw));
}

// Encrypt plaintext → returns "iv:ciphertext" (base64url encoded)
export async function encrypt(
  plaintext: string,
  keyBase64: string
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoded
  );
  return uint8ToBase64url(iv) + ":" + uint8ToBase64url(new Uint8Array(cipherBuffer));
}

// Decrypt "iv:ciphertext" → returns plaintext
export async function decrypt(
  payload: string,
  keyBase64: string
): Promise<string> {
  try {
    const idx = payload.indexOf(":");
    if (idx === -1) return "[Decryption failed]";
    const ivStr = payload.slice(0, idx);
    const cipherStr = payload.slice(idx + 1);
    const key = await importKey(keyBase64);
    const iv = base64urlToUint8(ivStr);
    const cipherData = base64urlToUint8(cipherStr);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGO, iv: iv as unknown as BufferSource },
      key,
      cipherData as unknown as BufferSource
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "[Decryption failed]";
  }
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64urlToUint8(keyBase64);
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: ALGO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function uint8ToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToUint8(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
