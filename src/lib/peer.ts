// WebRTC P2P file transfer — sender hosts, receivers pull
// Signaling via Firestore: rooms/{roomId}/signals/{docId}

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  where,
  deleteDoc,
  getDocs,
} from "firebase/firestore";
import { db } from "./firebase";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

const CHUNK_SIZE = 16384; // 16KB chunks

// ── Hosted files (sender keeps in memory) ──
const hostedFiles = new Map<string, ArrayBuffer>();

export function hostFile(mediaId: string, data: ArrayBuffer) {
  hostedFiles.set(mediaId, data);
}

export function removeHostedFile(mediaId: string) {
  hostedFiles.delete(mediaId);
}

// ── Signal helpers ──
interface Signal {
  type: "offer" | "answer" | "ice";
  mediaId: string;
  from: string;
  to: string;
  data: string; // JSON-stringified SDP or ICE candidate
}

async function sendSignal(roomId: string, signal: Signal) {
  await addDoc(collection(db, "rooms", roomId, "signals"), signal);
}

// ── Sender: listen for incoming requests and serve files ──

const activeSenderListeners = new Map<string, () => void>();

export function startHosting(roomId: string, userId: string) {
  // Already listening
  if (activeSenderListeners.has(roomId)) return;

  const q = query(
    collection(db, "rooms", roomId, "signals"),
    where("to", "==", userId),
    where("type", "==", "offer")
  );

  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const signal = change.doc.data() as Signal;
        handleIncomingRequest(roomId, userId, signal);
      }
    });
  });

  activeSenderListeners.set(roomId, unsub);
}

export function stopHosting(roomId: string) {
  const unsub = activeSenderListeners.get(roomId);
  if (unsub) {
    unsub();
    activeSenderListeners.delete(roomId);
  }
  hostedFiles.clear();
}

async function handleIncomingRequest(
  roomId: string,
  userId: string,
  signal: Signal
) {
  const maybeFile = hostedFiles.get(signal.mediaId);
  if (!maybeFile) return;
  const fileData: ArrayBuffer = maybeFile;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  const dc = pc.createDataChannel("file");

  dc.onopen = () => {
    // Send file size first, then chunks
    dc.send(JSON.stringify({ size: fileData.byteLength }));
    let offset = 0;
    function sendNextChunk() {
      while (dc.bufferedAmount < 65536 && offset < fileData.byteLength) {
        const end = Math.min(offset + CHUNK_SIZE, fileData.byteLength);
        dc.send(fileData.slice(offset, end));
        offset = end;
      }
      if (offset < fileData.byteLength) {
        setTimeout(sendNextChunk, 10);
      } else {
        setTimeout(() => dc.close(), 500);
      }
    }
    sendNextChunk();
  };

  // ICE candidates → Firestore
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(roomId, {
        type: "ice",
        mediaId: signal.mediaId,
        from: userId,
        to: signal.from,
        data: JSON.stringify(e.candidate),
      });
    }
  };

  // Set remote offer and create answer
  await pc.setRemoteDescription(JSON.parse(signal.data));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await sendSignal(roomId, {
    type: "answer",
    mediaId: signal.mediaId,
    from: userId,
    to: signal.from,
    data: JSON.stringify(answer),
  });

  // Listen for ICE from receiver
  const iceQ = query(
    collection(db, "rooms", roomId, "signals"),
    where("to", "==", userId),
    where("from", "==", signal.from),
    where("type", "==", "ice"),
    where("mediaId", "==", signal.mediaId)
  );

  const iceUnsub = onSnapshot(iceQ, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "added") {
        const ice = ch.doc.data() as Signal;
        pc.addIceCandidate(JSON.parse(ice.data));
      }
    });
  });

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "disconnected" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "failed"
    ) {
      iceUnsub();
      pc.close();
    }
  };
}

// ── Receiver: request file from sender via WebRTC ──

export function requestFile(
  roomId: string,
  mediaId: string,
  senderId: string,
  myUserId: string,
  onProgress: (pct: number) => void,
  onComplete: (data: ArrayBuffer) => void,
  onError: (err: string) => void
) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  let totalSize = 0;
  const chunks: ArrayBuffer[] = [];
  let received = 0;

  pc.ondatachannel = (event) => {
    const dc = event.channel;
    dc.binaryType = "arraybuffer";

    dc.onmessage = (e) => {
      if (typeof e.data === "string") {
        const meta = JSON.parse(e.data);
        totalSize = meta.size;
      } else {
        chunks.push(e.data as ArrayBuffer);
        received += (e.data as ArrayBuffer).byteLength;
        onProgress(totalSize > 0 ? Math.round((received / totalSize) * 100) : 0);
      }
    };

    dc.onclose = () => {
      if (received >= totalSize && totalSize > 0) {
        // Combine chunks
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        onComplete(result.buffer as ArrayBuffer);
      }
      cleanup();
    };

    dc.onerror = () => {
      onError("Transfer failed");
      cleanup();
    };
  };

  // ICE candidates → Firestore
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(roomId, {
        type: "ice",
        mediaId,
        from: myUserId,
        to: senderId,
        data: JSON.stringify(e.candidate),
      });
    }
  };

  // Listen for answer from sender
  const ansQ = query(
    collection(db, "rooms", roomId, "signals"),
    where("to", "==", myUserId),
    where("from", "==", senderId),
    where("type", "==", "answer"),
    where("mediaId", "==", mediaId)
  );

  const ansUnsub = onSnapshot(ansQ, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "added") {
        const sig = ch.doc.data() as Signal;
        pc.setRemoteDescription(JSON.parse(sig.data));
      }
    });
  });

  // Listen for ICE from sender
  const iceQ = query(
    collection(db, "rooms", roomId, "signals"),
    where("to", "==", myUserId),
    where("from", "==", senderId),
    where("type", "==", "ice"),
    where("mediaId", "==", mediaId)
  );

  const iceUnsub = onSnapshot(iceQ, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "added") {
        const ice = ch.doc.data() as Signal;
        pc.addIceCandidate(JSON.parse(ice.data));
      }
    });
  });

  function cleanup() {
    ansUnsub();
    iceUnsub();
    pc.close();
  }

  // Create offer and send to sender
  pc.createOffer().then(async (offer) => {
    await pc.setLocalDescription(offer);
    await sendSignal(roomId, {
      type: "offer",
      mediaId,
      from: myUserId,
      to: senderId,
      data: JSON.stringify(offer),
    });
  });

  // Timeout after 15s
  setTimeout(() => {
    if (received === 0) {
      onError("Sender is offline");
      cleanup();
    }
  }, 15000);
}

// ── Cleanup signals for a room ──
export async function cleanupSignals(roomId: string) {
  const signalsRef = collection(db, "rooms", roomId, "signals");
  const snap = await getDocs(signalsRef);
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}
