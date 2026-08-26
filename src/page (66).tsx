"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface Message {
  id: string;
  content: string;
  senderId: string;
  receiverId: string;
  senderFirstName: string;
  senderLastName: string;
  createdAt: string;
}

interface Conversation {
  partnerId: string;
  partnerName: string;
  lastMessage: string;
}

export default function ParentMessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [teachers, setTeachers] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.success) setCurrentUserId(data.data.user.id); });
    loadConversations();
    fetch("/api/users?role=teacher", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.success) setTeachers(data.data.users); })
      .catch(console.error);
  }, []);

  async function loadConversations() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/messages", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setConversations(data.data);
    } catch (err) {
      console.error(err);
    }
  }

  async function openConversation(partnerId: string) {
    setSelectedPartner(partnerId);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/messages?userId=${partnerId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setMessages(data.data);
    } catch (err) {
      console.error(err);
    }
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPartner || !newMessage.trim()) return;
    setSending(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receiverId: selectedPartner, content: newMessage }),
      });
      if (res.ok) {
        setNewMessage("");
        openConversation(selectedPartner);
        loadConversations();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Messages</h1>
        <p className="text-sm text-slate-500">Communicate with your child&apos;s teachers</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 h-[70vh]">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-slate-800">Conversations</h2>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {conversations.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">No conversations yet</div>
            ) : (
              conversations.map((conv) => (
                <button key={conv.partnerId} onClick={() => openConversation(conv.partnerId)}
                  className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                    selectedPartner === conv.partnerId ? "bg-purple-50" : ""
                  }`}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-purple-600 font-bold text-sm">
                      {conv.partnerName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-700 truncate">{conv.partnerName}</p>
                      <p className="text-xs text-slate-400 truncate">{conv.lastMessage}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="p-3 border-t border-slate-100">
            <select onChange={(e) => { if (e.target.value) openConversation(e.target.value); }}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm">
              <option value="">Message a teacher...</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
          {!selectedPartner ? (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <div className="text-6xl mb-4">💬</div>
                <p>Select a teacher to start chatting</p>
              </div>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-slate-100 bg-slate-50">
                <p className="font-bold text-slate-800">
                  {messages[0]?.senderId === selectedPartner
                    ? `${messages[0].senderFirstName} ${messages[0].senderLastName}`
                    : "Conversation"}
                </p>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="text-center text-slate-400 text-sm py-8">No messages yet</div>
                ) : (
                  [...messages].reverse().map((msg) => {
                    const isMine = msg.senderId === currentUserId;
                    return (
                      <div key={msg.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[75%] p-3 rounded-2xl ${
                          isMine ? "bg-purple-500 text-white rounded-br-sm" : "bg-slate-100 text-slate-700 rounded-bl-sm"
                        }`}>
                          <p className="text-sm">{msg.content}</p>
                          <p className={`text-[10px] mt-1 ${isMine ? "text-purple-100" : "text-slate-400"}`}>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <form onSubmit={sendMessage} className="p-3 border-t border-slate-100 flex gap-2">
                <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message..." className="flex-1 px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                <button type="submit" disabled={sending || !newMessage.trim()}
                  className="px-6 py-3 rounded-xl bg-purple-600 text-white font-semibold disabled:opacity-50">Send</button>
              </form>
            </>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
