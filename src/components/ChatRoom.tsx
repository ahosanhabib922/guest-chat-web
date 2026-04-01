"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getAnonymousUser,
  sendMessage,
  sendMediaMessage,
  editMessage,
  deleteMessage,
  subscribeToMessages,
  deleteRoom,
  getRoomInfo,
  generateMediaId,
  Message,
} from "@/lib/chat";
import { hostFile, startHosting, stopHosting, requestFile } from "@/lib/peer";

interface MediaState {
  url?: string;
  progress?: number;
  error?: string;
  loading?: boolean;
}

export default function ChatRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState("Guest");
  const [userAvatar, setUserAvatar] = useState("😀");
  const [encKey, setEncKey] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [mediaStates, setMediaStates] = useState<Record<string, MediaState>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const expiresAtRef = useRef<number | null>(null);

  const handleExit = useCallback(async () => {
    stopHosting(roomId);
    try {
      await deleteRoom(roomId);
    } catch {
      // Room may already be deleted
    }
    router.push("/");
  }, [roomId, router]);

  // Init
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      router.push("/");
      return;
    }
    setEncKey(hash);

    let unsubscribe: (() => void) | undefined;

    async function init() {
      const uid = await getAnonymousUser();
      setUserId(uid);
      setUserName(sessionStorage.getItem("guest-name") || "Guest");
      setUserAvatar(sessionStorage.getItem("guest-avatar") || "😀");

      const room = await getRoomInfo(roomId);
      if (room?.createdAt && room?.ttlMinutes) {
        const createdMs = room.createdAt.toMillis();
        expiresAtRef.current = createdMs + room.ttlMinutes * 60 * 1000;
      }

      // Start hosting files (listen for P2P requests)
      startHosting(roomId, uid);

      unsubscribe = subscribeToMessages(roomId, hash, setMessages);
    }

    init();
    return () => {
      unsubscribe?.();
      stopHosting(roomId);
    };
  }, [roomId, router]);

  // TTL countdown
  useEffect(() => {
    const interval = setInterval(() => {
      if (!expiresAtRef.current) return;
      const remaining = expiresAtRef.current - Date.now();
      if (remaining <= 0) {
        setExpired(true);
        setTimeLeft("Expired");
        clearInterval(interval);
        stopHosting(roomId);
        deleteRoom(roomId).then(() => router.push("/"));
        return;
      }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      if (h > 0) setTimeLeft(`${h}h ${m}m`);
      else if (m > 0) setTimeLeft(`${m}m ${s}s`);
      else setTimeLeft(`${s}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [roomId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    function handleClick() { setMenuOpenId(null); }
    if (menuOpenId) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [menuOpenId]);

  // ── Handlers ──

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || !userId || !encKey) return;
    setText("");

    const optimisticMsg: Message = {
      id: `temp-${Date.now()}`,
      text: trimmed,
      senderId: userId,
      senderName: userName,
      senderAvatar: userAvatar,
      timestamp: null,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    sendMessage(roomId, trimmed, userId, userName, userAvatar, encKey);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !userId || !encKey) return;
    e.target.value = "";

    const mediaId = generateMediaId();
    const buffer = await file.arrayBuffer();

    // Host the file in memory for P2P
    hostFile(mediaId, buffer);

    // Show local preview immediately
    const blobUrl = URL.createObjectURL(file);
    setMediaStates((prev) => ({ ...prev, [mediaId]: { url: blobUrl } }));

    // Send metadata to Firestore (no file data!)
    await sendMediaMessage(
      roomId,
      userId,
      userName,
      userAvatar,
      encKey,
      mediaId,
      file.name,
      file.type,
      file.size
    );
  }

  function handleRequestMedia(msg: Message) {
    if (!msg.mediaId || !userId) return;

    setMediaStates((prev) => ({
      ...prev,
      [msg.mediaId!]: { loading: true, progress: 0 },
    }));

    requestFile(
      roomId,
      msg.mediaId,
      msg.senderId,
      userId,
      (pct) => {
        setMediaStates((prev) => ({
          ...prev,
          [msg.mediaId!]: { loading: true, progress: pct },
        }));
      },
      (data) => {
        const blob = new Blob([data], { type: msg.mediaType || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        setMediaStates((prev) => ({
          ...prev,
          [msg.mediaId!]: { url },
        }));
      },
      (err) => {
        setMediaStates((prev) => ({
          ...prev,
          [msg.mediaId!]: { error: err },
        }));
      }
    );
  }

  async function handleEdit(messageId: string) {
    const trimmed = editText.trim();
    if (!trimmed || !encKey) return;
    await editMessage(roomId, messageId, trimmed, encKey);
    setEditingId(null);
    setEditText("");
  }

  async function handleDelete(messageId: string) {
    await deleteMessage(roomId, messageId);
    setMenuOpenId(null);
  }

  function startEdit(msg: Message) {
    setEditingId(msg.id);
    setEditText(msg.text);
    setMenuOpenId(null);
  }

  function handleCopyLink() {
    const link = `${window.location.origin}/chat/${roomId}#${encKey}`;
    navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  function formatTime(timestamp: Message["timestamp"]): string {
    if (!timestamp) return "";
    const date = timestamp.toDate();
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function isImage(type?: string) {
    return type?.startsWith("image/");
  }

  function isVideo(type?: string) {
    return type?.startsWith("video/");
  }

  if (expired) return null;

  // ── Render ──

  function renderMedia(msg: Message, isMe: boolean) {
    if (!msg.mediaId) return null;
    const state = mediaStates[msg.mediaId];

    // Has URL (either local preview for sender or received via P2P)
    if (state?.url) {
      if (isImage(msg.mediaType)) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={state.url}
            alt={msg.mediaName || "Image"}
            className="mt-2 max-w-full rounded-lg max-h-64 object-contain cursor-pointer"
            onClick={() => window.open(state.url, "_blank")}
          />
        );
      }
      if (isVideo(msg.mediaType)) {
        return (
          <video
            src={state.url}
            controls
            className="mt-2 max-w-full rounded-lg max-h-64"
          />
        );
      }
      // Other file types — download link
      return (
        <a
          href={state.url}
          download={msg.mediaName}
          className={`mt-2 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
            isMe
              ? "bg-indigo-500 text-white hover:bg-indigo-400"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          Download {msg.mediaName}
        </a>
      );
    }

    // Loading / transferring
    if (state?.loading) {
      return (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-2 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${state.progress || 0}%` }}
            />
          </div>
          <span className={`text-[10px] ${isMe ? "text-indigo-200" : "text-zinc-400"}`}>
            {state.progress}%
          </span>
        </div>
      );
    }

    // Error
    if (state?.error) {
      return (
        <p className={`mt-1 text-[10px] ${isMe ? "text-red-200" : "text-red-400"}`}>
          {state.error}
        </p>
      );
    }

    // Not yet requested — show download button (for receivers)
    if (msg.senderId !== userId) {
      return (
        <button
          onClick={() => handleRequestMedia(msg)}
          className={`mt-2 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${
            isMe
              ? "bg-indigo-500 text-white hover:bg-indigo-400"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          Receive {msg.mediaName} ({formatSize(msg.mediaSize || 0)})
        </button>
      );
    }

    return null;
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-3">
          <button
            onClick={handleExit}
            className="rounded-lg p-2 text-zinc-500 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
            title="Exit & Delete Room"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 3a1 1 0 011-1h5a1 1 0 010 2H5v12h4a1 1 0 110 2H4a1 1 0 01-1-1V3z" clipRule="evenodd" />
              <path fillRule="evenodd" d="M13.293 9.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L14.586 14H7a1 1 0 110-2h7.586l-1.293-1.293a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Guest Chat
            </h1>
            <button
              onClick={handleCopyLink}
              className="flex items-center gap-1.5 text-xs text-indigo-600 transition hover:text-indigo-800 dark:text-indigo-400"
            >
              <span className="font-mono">{roomId}</span>
              <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-medium dark:bg-indigo-950">
                {copiedLink ? "Link Copied!" : "Share Link"}
              </span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {timeLeft && (
            <span className={`text-xs font-mono ${
              timeLeft.includes("s") && !timeLeft.includes("m")
                ? "text-red-500 animate-pulse"
                : "text-zinc-500 dark:text-zinc-400"
            }`}>
              ⏱ {timeLeft}
            </span>
          )}
          <div className="flex items-center gap-2">
            <span className="text-lg">{userAvatar}</span>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{userName}</span>
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          </div>
        </div>
      </header>

      {/* E2E badge */}
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-green-50 px-3 py-1 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
          🔒 End-to-end encrypted — media shared peer-to-peer, never uploaded
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-zinc-400">
            <p className="text-lg">No messages yet</p>
            <p className="mt-1 text-sm">
              Click <span className="font-medium text-indigo-500">&quot;Share Link&quot;</span> above to invite others
            </p>
          </div>
        )}
        {messages.map((msg) => {
          const isMe = msg.senderId === userId;
          return (
            <div
              key={msg.id}
              className={`flex items-end gap-2 ${isMe ? "justify-end" : "justify-start"}`}
            >
              {!isMe && (
                <span className="mb-1 text-lg" title={msg.senderName}>
                  {msg.senderAvatar || "😀"}
                </span>
              )}

              <div className="relative group">
                {!isMe && (
                  <p className="mb-0.5 ml-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                    {msg.senderName || "Guest"}
                  </p>
                )}

                {editingId === msg.id && !msg.mediaId ? (
                  <div className="flex items-center gap-2">
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleEdit(msg.id);
                        if (e.key === "Escape") {
                          setEditingId(null);
                          setEditText("");
                        }
                      }}
                      className="rounded-xl border border-indigo-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:border-indigo-700 dark:bg-zinc-800 dark:text-white"
                    />
                    <button
                      onClick={() => handleEdit(msg.id)}
                      className="rounded-lg bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-700"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setEditingId(null); setEditText(""); }}
                      className="rounded-lg bg-zinc-200 px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                      isMe
                        ? "bg-indigo-600 text-white rounded-br-md"
                        : "bg-white text-zinc-900 dark:bg-zinc-800 dark:text-white rounded-bl-md"
                    }`}
                  >
                    {!msg.mediaId && (
                      <p className="break-words whitespace-pre-wrap">{msg.text}</p>
                    )}
                    {msg.mediaId && (
                      <p className="text-xs opacity-75">
                        📎 {msg.mediaName} ({formatSize(msg.mediaSize || 0)})
                      </p>
                    )}

                    {/* Media content */}
                    {renderMedia(msg, isMe)}

                    <p
                      className={`mt-1 text-[10px] ${
                        isMe ? "text-indigo-200" : "text-zinc-400"
                      }`}
                    >
                      {formatTime(msg.timestamp)}
                      {msg.edited && " (edited)"}
                    </p>

                    {/* Action menu */}
                    {isMe && (
                      <div className="absolute -top-2 right-0 hidden group-hover:flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpenId === msg.id ? null : msg.id);
                          }}
                          className="rounded-full bg-white p-1 text-zinc-400 shadow-md hover:text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
                          </svg>
                        </button>

                        {menuOpenId === msg.id && (
                          <div className="absolute right-0 top-7 z-10 min-w-[120px] rounded-xl bg-white py-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
                            {!msg.mediaId && (
                              <button
                                onClick={() => startEdit(msg)}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                </svg>
                                Edit
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(msg.id)}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                              </svg>
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {isMe && (
                <span className="mb-1 text-lg" title={userName}>
                  {userAvatar}
                </span>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex gap-2">
          {/* File attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-zinc-500 transition hover:bg-zinc-100 hover:text-indigo-600 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            title="Send image, video, or file (P2P)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z" clipRule="evenodd" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.zip,.txt"
            onChange={handleFileSelect}
            className="hidden"
          />

          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white dark:focus:ring-indigo-800"
          />
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="rounded-xl bg-indigo-600 px-5 py-3 text-white transition hover:bg-indigo-700 disabled:opacity-40"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
