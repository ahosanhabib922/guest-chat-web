"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  generateRoomCode,
  createRoom,
  getAnonymousUser,
  cleanupExpiredRooms,
  AVATARS,
  TTL_OPTIONS,
} from "@/lib/chat";
import { generateEncryptionKey } from "@/lib/crypto";

export default function HomePage() {
  // Clean up expired rooms on every home page visit
  useEffect(() => {
    cleanupExpiredRooms();
  }, []);
  const router = useRouter();
  const [joinLink, setJoinLink] = useState("");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[2].value); // default 1 hour
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function saveProfile() {
    sessionStorage.setItem("guest-name", name.trim() || "Guest");
    sessionStorage.setItem("guest-avatar", avatar);
  }

  async function handleStartChat() {
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await getAnonymousUser();
      saveProfile();
      const code = generateRoomCode();
      const key = await generateEncryptionKey();
      await createRoom(code, ttl);
      // Key goes in URL hash — never sent to server
      router.push(`/chat/${code}#${key}`);
    } catch {
      setError("Failed to create chat room. Please try again.");
      setLoading(false);
    }
  }

  function parseJoinLink(input: string): { code: string; key: string } | null {
    const trimmed = input.trim();
    // Full URL: https://domain/chat/ABCDEF#encryptionKey
    const urlMatch = trimmed.match(/\/chat\/([A-Z0-9]{6})#(.+)$/i);
    if (urlMatch) return { code: urlMatch[1].toUpperCase(), key: urlMatch[2] };
    return null;
  }

  async function handleJoinChat() {
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    const parsed = parseJoinLink(joinLink);
    if (!parsed) {
      setError("Invalid link. Paste the full invite link from the host.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await getAnonymousUser();
      saveProfile();
      router.push(`/chat/${parsed.code}#${parsed.key}`);
    } catch {
      setError("Failed to join chat. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-zinc-950 dark:to-zinc-900 px-4 py-8">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600 text-3xl text-white shadow-lg">
            💬
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
            Guest Chat
          </h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">
            End-to-end encrypted. No account. No trace.
          </p>
        </div>

        {/* Profile Setup */}
        <div className="rounded-2xl bg-white p-6 shadow-md dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
            Your Profile
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Choose a name and avatar for this session.
          </p>
          <input
            type="text"
            maxLength={20}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name..."
            className="mt-3 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:ring-indigo-800"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {AVATARS.map((a) => (
              <button
                key={a}
                onClick={() => setAvatar(a)}
                className={`flex h-10 w-10 items-center justify-center rounded-xl text-xl transition ${
                  avatar === a
                    ? "bg-indigo-100 ring-2 ring-indigo-500 dark:bg-indigo-900"
                    : "bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-700 dark:hover:bg-zinc-600"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* Start Chat */}
        <div className="rounded-2xl bg-white p-6 shadow-md dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
            Start a New Chat
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Create an encrypted room. Set how long it lasts.
          </p>

          {/* TTL Selector */}
          <div className="mt-3">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Auto-delete after
            </label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {TTL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTtl(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    ttl === opt.value
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleStartChat}
            disabled={loading}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Start Chat"}
          </button>
        </div>

        {/* Join Chat */}
        <div className="rounded-2xl bg-white p-6 shadow-md dark:bg-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
            Join a Chat
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Paste the invite link from the host.
          </p>
          <input
            type="text"
            value={joinLink}
            onChange={(e) => setJoinLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoinChat()}
            placeholder="Paste invite link here..."
            className="mt-3 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:ring-indigo-800"
          />
          <button
            onClick={handleJoinChat}
            disabled={loading}
            className="mt-3 w-full rounded-xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Join
          </button>
        </div>

        {/* Error */}
        {error && (
          <p className="text-center text-sm text-red-500">{error}</p>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-zinc-400 dark:text-zinc-600 space-y-1">
          <p>🔒 End-to-end encrypted. Even we can&apos;t read your messages.</p>
          <p>Messages auto-delete after your chosen time.</p>
        </div>
      </div>
    </div>
  );
}
