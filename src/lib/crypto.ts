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
  return bufferToBase64url(raw);
}

// Encrypt plaintext → returns base64url encoded "iv:ciphertext"
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
  const ivStr = bufferToBase64url(iv.buffer as ArrayBuffer);
  const cipherStr = bufferToBase64url(cipherBuffer);
  return `${ivStr}:${cipherStr}`;
}

// Decrypt "iv:ciphertext" → returns plaintext
export async function decrypt(
  payload: string,
  keyBase64: string
): Promise<string> {
  try {
    const [ivStr, cipherStr] = payload.split(":");
    const key = await importKey(keyBase64);
    const iv = base64urlToArrayBuffer(ivStr);
    const cipherBuffer = base64urlToArrayBuffer(cipherStr);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGO, iv },
      key,
      cipherBuffer
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "[Decryption failed]";
  }
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64urlToArrayBuffer(keyBase64);
  return crypto.subtle.importKey("raw", raw, { name: ALGO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}
