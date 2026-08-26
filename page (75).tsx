"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { teacherNav } from "@/lib/teacher-nav";

interface Message {
  id: string;
  content: string;
  senderId: string;
  receiverId: string;
  senderFirstName: string;
  senderLastName: string;
  receiverFirstName: string;
  receiverLastName: string;
  createdAt: string;
}

interface Conversation {
  partnerId: string;
  partnerName: string;
  lastMessage: string;
  lastMessageAt: string;
  isRead: boolean;
}

export default function TeacherMessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<{ id: string; firstName: string; lastName: string; role: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedUser = localStorage.getItem("el_user");
    if (storedUser) {
      const user = JSON.parse(storedUser);
      setCurrentUserId(user.id);
      // Need user id - fetch via /api/auth/me
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${localStorage.getItem("el_token")}` } })
        .then((r) => r.json())
        .then((data) => { if (data.success) setCurrentUserId(data.data.user.id); });
    }
    loadConversations();
    loadUsers();
  }, []);

  async function loadConversations() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/messages", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setConversations(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadUsers() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/users?limit=100", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setUsers(data.data.users);
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
      const data = await res.json();
      if (data.success) {
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
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Messages</h1>
        <p className="text-sm text-slate-500">Chat with learners, parents, and staff</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 h-[70vh]">
        {/* Conversation List */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-slate-800">Conversations</h2>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {loading ? (
              <div className="p-4 animate-pulse space-y-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-slate-100 rounded-xl" />)}
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">No conversations yet</div>
            ) : (
              conversations.map((conv) => (
                <button key={conv.partnerId} onClick={() => openConversation(conv.partnerId)}
                  className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                    selectedPartner === conv.partnerId ? "bg-secondary-50" : ""
                  }`}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-secondary-100 flex items-center justify-center text-secondary-600 font-bold text-sm">
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

          {/* New conversation */}
          <div className="p-3 border-t border-slate-100">
            <select
              onChange={(e) => { if (e.target.value) openConversation(e.target.value); }}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
            >
              <option value="">Start new chat...</option>
              {users.filter((u) => u.id !== currentUserId).map((u) => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.role})</option>
              ))}
            </select>
          </div>
        </div>

        {/* Messages */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
          {!selectedPartner ? (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <div className="text-6xl mb-4">💬</div>
                <p>Select a conversation to start chatting</p>
              </div>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-slate-100 bg-slate-50">
                <p className="font-bold text-slate-800">
                  {messages[0]?.senderId === selectedPartner
                    ? `${messages[0].senderFirstName} ${messages[0].senderLastName}`
                    : messages[0]?.receiverId === selectedPartner
                    ? `${messages[0].receiverFirstName} ${messages[0].receiverLastName}`
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
                          isMine ? "bg-secondary-500 text-white rounded-br-sm" : "bg-slate-100 text-slate-700 rounded-bl-sm"
                        }`}>
                          <p className="text-sm">{msg.content}</p>
                          <p className={`text-[10px] mt-1 ${isMine ? "text-secondary-100" : "text-slate-400"}`}>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <form onSubmit={sendMessage} className="p-3 border-t border-slate-100 flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm"
                />
                <button type="submit" disabled={sending || !newMessage.trim()}
                  className="px-6 py-3 rounded-xl gradient-secondary text-white font-semibold disabled:opacity-50">
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
