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

export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  timestamp: Timestamp | null;
  edited?: boolean;
  // Media fields (only present for media messages)
  mediaId?: string;
  mediaName?: string;
  mediaType?: string; // MIME type
  mediaSize?: number;
}

interface RawMessage {
  id: string;
  encText: string;
  encName: string;
  senderAvatar: string;
  senderId: string;
  timestamp: Timestamp | null;
  edited?: boolean;
  mediaId?: string;
  encMediaName?: string;
  mediaType?: string;
  mediaSize?: number;
}

export function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function generateMediaId(): string {
  return `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getAnonymousUser(): Promise<string> {
  const credential = await signInAnonymously(auth);
  return credential.user.uid;
}

export async function createRoom(
  roomId: string,
  ttlMinutes: number
): Promise<void> {
  await setDoc(doc(db, "rooms", roomId), {
    createdAt: serverTimestamp(),
    ttlMinutes,
  });
}

export async function getRoomInfo(
  roomId: string
): Promise<{ createdAt: Timestamp; ttlMinutes: number } | null> {
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists()) return null;
  return snap.data() as { createdAt: Timestamp; ttlMinutes: number };
}

// Send a text message (encrypted)
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
  });
}

// Send a media message (metadata only — file stays with sender)
export async function sendMediaMessage(
  roomId: string,
  senderId: string,
  senderName: string,
  senderAvatar: string,
  encryptionKey: string,
  mediaId: string,
  mediaName: string,
  mediaType: string,
  mediaSize: number
): Promise<void> {
  const encName = await encrypt(senderName, encryptionKey);
  const encMediaName = await encrypt(mediaName, encryptionKey);
  const encText = await encrypt(`📎 ${mediaName}`, encryptionKey);
  await addDoc(collection(db, "rooms", roomId, "messages"), {
    encText,
    encName,
    senderAvatar,
    senderId,
    mediaId,
    encMediaName,
    mediaType,
    mediaSize,
    timestamp: serverTimestamp(),
  });
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
        if (raw.mediaId) {
          msg.mediaId = raw.mediaId;
          msg.mediaName = raw.encMediaName
            ? await decrypt(raw.encMediaName, encryptionKey)
            : undefined;
          msg.mediaType = raw.mediaType;
          msg.mediaSize = raw.mediaSize;
        }
        return msg;
      })
    );

    callback(decrypted);
  });
}

export async function deleteRoom(roomId: string): Promise<void> {
  // Delete messages
  const messagesRef = collection(db, "rooms", roomId, "messages");
  const msgSnap = await getDocs(messagesRef);
  await Promise.all(msgSnap.docs.map((d) => deleteDoc(d.ref)));

  // Delete signals
  const signalsRef = collection(db, "rooms", roomId, "signals");
  const sigSnap = await getDocs(signalsRef);
  await Promise.all(sigSnap.docs.map((d) => deleteDoc(d.ref)));

  // Delete room
  await deleteDoc(doc(db, "rooms", roomId));
}
