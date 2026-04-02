import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  Timestamp,
  where,
} from "firebase/firestore";
import { signInAnonymously } from "firebase/auth";
import { db, auth } from "./firebase";
import { encrypt, decrypt } from "./crypto";

export const AVATARS = ["😀", "😎", "🤖", "👻", "🦊", "🐱", "🐸", "🦄", "🐼", "🐵", "🦁", "🐯"];

export const TTL_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
] as const;

// Max file size: 5MB (after base64 + encryption, fits in Firestore chunks)
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  timestamp: Timestamp | null;
  edited?: boolean;
  mediaName?: string;
  mediaType?: string;
  mediaSize?: number;
  encMediaData?: string; // encrypted base64 file data (inline for small files)
  mediaChunks?: number;  // number of chunks (for large files)
}

interface RawMessage {
  id: string;
  encText: string;
  encName: string;
  senderAvatar: string;
  senderId: string;
  timestamp: Timestamp | null;
  edited?: boolean;
  encMediaName?: string;
  mediaType?: string;
  mediaSize?: number;
  encMediaData?: string;
  mediaChunks?: number;
}

export function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function getAnonymousUser(): Promise<string> {
  const credential = await signInAnonymously(auth);
  return credential.user.uid;
}

export async function createRoom(
  roomId: string,
  ttlMinutes: number
): Promise<void> {
  const expiresAt = Timestamp.fromMillis(Date.now() + ttlMinutes * 60 * 1000);
  await setDoc(doc(db, "rooms", roomId), {
    createdAt: serverTimestamp(),
    ttlMinutes,
    expiresAt,
  });
}

export async function getRoomInfo(
  roomId: string
): Promise<{ createdAt: Timestamp; ttlMinutes: number; expiresAt: Timestamp } | null> {
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists()) return null;
  return snap.data() as { createdAt: Timestamp; ttlMinutes: number; expiresAt: Timestamp };
}

// Cache room expiresAt for attaching to messages
let _roomExpiresAt: Timestamp | null = null;

export function setRoomExpiresAt(ts: Timestamp) {
  _roomExpiresAt = ts;
}

function getExpiresAt(): Timestamp {
  // Fallback: 1 hour from now if not set
  return _roomExpiresAt || Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
}

export async function sendMessage(
  roomId: string,
  text: string,
  senderId: string,
  senderName: string,
  senderAvatar: string,
  encryptionKey: string
): Promise<void> {
  const encText = await encrypt(text, encryptionKey);
  const encName = await encrypt(senderName, encryptionKey);
  await addDoc(collection(db, "rooms", roomId, "messages"), {
    encText,
    encName,
    senderAvatar,
    senderId,
    timestamp: serverTimestamp(),
    expiresAt: getExpiresAt(),
  });
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert base64 string to ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

// Firestore doc limit ~1MB. Keep chunk data under 800KB to be safe.
const CHUNK_MAX = 800000;

// Send media message — encrypt file data and store in Firestore
export async function sendMediaMessage(
  roomId: string,
  senderId: string,
  senderName: string,
  senderAvatar: string,
  encryptionKey: string,
  mediaName: string,
  mediaType: string,
  fileData: ArrayBuffer
): Promise<void> {
  const encName = await encrypt(senderName, encryptionKey);
  const encMediaName = await encrypt(mediaName, encryptionKey);
  const encText = await encrypt(`📎 ${mediaName}`, encryptionKey);

  // Convert file to base64, then encrypt
  const base64Data = arrayBufferToBase64(fileData);
  const encMediaData = await encrypt(base64Data, encryptionKey);

  const expiry = getExpiresAt();

  if (encMediaData.length <= CHUNK_MAX) {
    // Small file — store inline
    await addDoc(collection(db, "rooms", roomId, "messages"), {
      encText,
      encName,
      senderAvatar,
      senderId,
      encMediaName,
      mediaType,
      mediaSize: fileData.byteLength,
      encMediaData,
      timestamp: serverTimestamp(),
      expiresAt: expiry,
    });
  } else {
    // Large file — store in chunks subcollection
    const chunks = Math.ceil(encMediaData.length / CHUNK_MAX);
    const msgRef = await addDoc(collection(db, "rooms", roomId, "messages"), {
      encText,
      encName,
      senderAvatar,
      senderId,
      encMediaName,
      mediaType,
      mediaSize: fileData.byteLength,
      mediaChunks: chunks,
      timestamp: serverTimestamp(),
      expiresAt: expiry,
    });

    // Write chunks in parallel
    const chunkPromises = [];
    for (let i = 0; i < chunks; i++) {
      const start = i * CHUNK_MAX;
      const end = Math.min(start + CHUNK_MAX, encMediaData.length);
      chunkPromises.push(
        setDoc(
          doc(db, "rooms", roomId, "messages", msgRef.id, "chunks", String(i)),
          { data: encMediaData.slice(start, end), expiresAt: expiry }
        )
      );
    }
    await Promise.all(chunkPromises);
  }
}

// Load media data for a message (handles both inline and chunked)
export async function loadMediaData(
  roomId: string,
  messageId: string,
  encMediaData: string | undefined,
  mediaChunks: number | undefined,
  encryptionKey: string
): Promise<ArrayBuffer | null> {
  try {
    let fullEncData: string;

    if (encMediaData) {
      fullEncData = encMediaData;
    } else if (mediaChunks && mediaChunks > 0) {
      // Load chunks
      const parts: string[] = [];
      for (let i = 0; i < mediaChunks; i++) {
        const chunkSnap = await getDoc(
          doc(db, "rooms", roomId, "messages", messageId, "chunks", String(i))
        );
        if (chunkSnap.exists()) {
          parts.push(chunkSnap.data().data as string);
        }
      }
      fullEncData = parts.join("");
    } else {
      return null;
    }

    const base64Data = await decrypt(fullEncData, encryptionKey);
    if (base64Data === "[Decryption failed]") return null;
    return base64ToArrayBuffer(base64Data);
  } catch {
    return null;
  }
}

export async function editMessage(
  roomId: string,
  messageId: string,
  newText: string,
  encryptionKey: string
): Promise<void> {
  const encText = await encrypt(newText, encryptionKey);
  await updateDoc(doc(db, "rooms", roomId, "messages", messageId), {
    encText,
    edited: true,
  });
}

export async function deleteMessage(
  roomId: string,
  messageId: string
): Promise<void> {
  // Delete chunks if any
  const chunksRef = collection(db, "rooms", roomId, "messages", messageId, "chunks");
  const chunksSnap = await getDocs(chunksRef);
  await Promise.all(chunksSnap.docs.map((d) => deleteDoc(d.ref)));
  // Delete message
  await deleteDoc(doc(db, "rooms", roomId, "messages", messageId));
}

export function subscribeToMessages(
  roomId: string,
  encryptionKey: string,
  callback: (messages: Message[]) => void
): () => void {
  const q = query(
    collection(db, "rooms", roomId, "messages"),
    orderBy("timestamp", "asc")
  );

  return onSnapshot(q, async (snapshot) => {
    const rawMessages: RawMessage[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    })) as RawMessage[];

    const decrypted = await Promise.all(
      rawMessages.map(async (raw) => {
        const msg: Message = {
          id: raw.id,
          text: await decrypt(raw.encText, encryptionKey),
          senderId: raw.senderId,
          senderName: await decrypt(raw.encName, encryptionKey),
          senderAvatar: raw.senderAvatar,
          timestamp: raw.timestamp,
          edited: raw.edited,
        };
        if (raw.encMediaName || raw.encMediaData || raw.mediaChunks) {
          msg.mediaName = raw.encMediaName
            ? await decrypt(raw.encMediaName, encryptionKey)
            : undefined;
          msg.mediaType = raw.mediaType;
          msg.mediaSize = raw.mediaSize;
          msg.encMediaData = raw.encMediaData;
          msg.mediaChunks = raw.mediaChunks;
        }
        return msg;
      })
    );

    callback(decrypted);
  });
}

export async function deleteRoom(roomId: string): Promise<void> {
  const messagesRef = collection(db, "rooms", roomId, "messages");
  const msgSnap = await getDocs(messagesRef);
  for (const msgDoc of msgSnap.docs) {
    const chunksRef = collection(db, "rooms", roomId, "messages", msgDoc.id, "chunks");
    const chunksSnap = await getDocs(chunksRef);
    await Promise.all(chunksSnap.docs.map((d) => deleteDoc(d.ref)));
  }
  await Promise.all(msgSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "rooms", roomId));
}

// Clean up all expired rooms — runs on every app/page load
export async function cleanupExpiredRooms(): Promise<void> {
  try {
    const now = Timestamp.now();
    const q = query(
      collection(db, "rooms"),
      where("expiresAt", "<=", now)
    );
    const snapshot = await getDocs(q);
    const deletions = snapshot.docs.map((d) => deleteRoom(d.id));
    await Promise.all(deletions);
  } catch {
    // Silently ignore — cleanup is best-effort
  }
}
