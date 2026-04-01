"use client";

import dynamic from "next/dynamic";

const ChatRoom = dynamic(() => import("@/components/ChatRoom"), { ssr: false });

export default function Page() {
  return <ChatRoom />;
}
