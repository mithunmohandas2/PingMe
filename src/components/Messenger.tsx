"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ProfilePanel from "./ProfilePanel";
import ChatImageEditor from "./ChatImageEditor";
import MessagePreview from "./MessagePreview";
import { imageExpired } from "@/lib/image-messages";
import { compressImage } from "@/lib/compress-image";
import PhotoPreview from "./PhotoPreview";
import MessageActionDialog from "./MessageActionDialog";
import SignOutDialog from "./SignOutDialog";
import ChatActionDialog, { type ChatActionType } from "./ChatActionDialog";
import MessageBubble, { type ChatMessage } from "./MessageBubble";
import OpeningLoader from "./OpeningLoader";
import AppLogo from "./AppLogo";
import {
  createMessageSoundPlayer,
  createMessageSoundTracker,
} from "@/lib/message-sounds";
import ContactScanner from "./ContactScanner";
import { parseContactLink, type ContactUser } from "@/lib/contacts";
import {
  createChatSync,
  createEventStream,
  createReadDeduper,
  mergeMessages,
} from "@/lib/chat-sync";
import {
  Eraser,
  Ban,
  LogOut as LeaveGroupIcon,
  ImagePlus,
  Pencil,
  Trash2,
  ArrowLeft,
  Check,
  ChevronDown,
  LogOut,
  MessageCircle,
  QrCode,
  Search,
  Send,
  ShieldCheck,
  Users,
  UserRound,
  X,
} from "lucide-react";
type User = ContactUser;
type Message = ChatMessage;
type Chat = {
  _id: string;
  chatName: string;
  isGroup: boolean;
  users: User[];
  groupAdmin?: User;
  latestMessage?: Message;
  activityMessage?: Message;
  updatedAt: string;
  accountPurgeAt?: string | null;
  clearedAt?: string | null;
  blockedByMe?: boolean;
  messagingBlocked?: boolean;
};
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const readOnce = createReadDeduper();
function request<T>(
  path: string,
  options?: RequestInit,
  scope = "",
): Promise<T> {
  const execute = async () => {
    const response = await fetch("/api" + path, {
      ...options,
      headers: {
        ...(options?.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options?.headers,
      },
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new RequestError(
        result.message || "Request failed",
        response.status,
      );
    return result.data as T;
  };
  return !options?.method || options.method === "GET"
    ? readOnce(scope + ":" + path, execute)
    : execute();
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
}
function Avatar({ user, large = false }: { user?: User; large?: boolean }) {
  return (
    <div
      className={"avatar " + (large ? "big" : "")}
      aria-label={user?.name || "User"}
    >
      {user?.image ? (
        <img
          alt=""
          src={user.image}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <span>{initials(user?.name || "?")}</span>
      )}
    </div>
  );
}
export default function Messenger() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .catch(() => {});
    }
  }, []);
  const [previewUser, setPreviewUser] = useState<User | null>(null);
  const [me, setMe] = useState<User | null>(null),
    [auth, setAuth] = useState<"login" | "register">("login"),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [messages, setMessages] = useState<Message[]>([]);
  const [mobileChat, setMobileChat] = useState(false),
    [wsActive, setWsActive] = useState(false);
  const [chatAction, setChatAction] = useState<{
    action: ChatActionType;
    chatId: string;
    name: string;
  } | null>(null);
  const [chatPhoto, setChatPhoto] = useState<{
    file: File;
    chatId: string;
    epoch: number;
  } | null>(null);
  const chatPhotoInput = useRef<HTMLInputElement>(null);
  const [messageSelection, setMessageSelection] = useState<Set<string>>(
    new Set(),
  );
  const [messageAction, setMessageAction] = useState<{
    action: "delete";
    messages: Message[];
  } | null>(null);
  const selectedMessages = messages.filter(
    (message) =>
      messageSelection.has(message._id) &&
      message.sender._id === me?._id &&
      !message.deletedAt &&
      message.kind !== "group-rename" &&
      !imageExpired(message),
  );
  const selectionMode = selectedMessages.length > 0;
  useEffect(() => {
    setMessageSelection(new Set());
    setMessageAction(null);
    setChatPhoto(null);
    setChatAction(null);
  }, [selected, me?._id, mobileChat]);
  useEffect(() => {
    const available = new Set(
      messages
        .filter(
          (message) =>
            message.sender._id === me?._id &&
            !message.deletedAt &&
            message.kind !== "group-rename",
        )
        .map((message) => message._id),
    );
    setMessageSelection((previous) => {
      const next = new Set([...previous].filter((id) => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [messages, me?._id]);
  useEffect(() => {
    if (!selectionMode) return;
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector("dialog[open], .controls-open")
      )
        setMessageSelection(new Set());
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [selectionMode]);
  function toggleMessage(id: string) {
    setMessageSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [search, setSearch] = useState(""),
    [groupSearch, setGroupSearch] = useState(""),
    [groupResults, setGroupResults] = useState<User[]>([]),
    [compose, setCompose] = useState(""),
    [showGroup, setShowGroup] = useState(false),
    [groupName, setGroupName] = useState(""),
    [groupMembers, setGroupMembers] = useState<string[]>([]),
    [showRename, setShowRename] = useState(false),
    [rename, setRename] = useState("");
  const [editingMessage, setEditingMessage] = useState<{
    message: Message;
    chatId: string;
    previousDraft: string;
  } | null>(null);
  const composerInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingMessage) {
      setCompose(editingMessage.previousDraft);
      setEditingMessage(null);
    }
  }, [selected, me?._id, mobileChat]);
  useEffect(() => {
    if (editingMessage) composerInput.current?.focus();
  }, [editingMessage]);
  useEffect(() => {
    if (
      editingMessage &&
      !messages.some(
        (message) =>
          message._id === editingMessage.message._id && !message.deletedAt,
      )
    ) {
      setCompose(editingMessage.previousDraft);
      setEditingMessage(null);
    }
  }, [messages, editingMessage]);
  function startEditing(message: Message) {
    if (
      !selected ||
      busy ||
      chatReadOnly ||
      message.kind === "image" ||
      message.kind === "group-rename"
    )
      return;
    setEditingMessage({
      message,
      chatId: selected,
      previousDraft: editingMessage?.previousDraft ?? compose,
    });
    setCompose(message.content);
    setMessageSelection(new Set());
    setError("");
  }
  function cancelEditing() {
    if (!editingMessage || busy) return;
    setCompose(editingMessage.previousDraft);
    setEditingMessage(null);
    composerInput.current?.focus();
  }
  const [showSignOut, setShowSignOut] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contact, setContact] = useState<User | null>(null);
  const [contactError, setContactError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const scanButton = useRef<HTMLButtonElement>(null);
  const clearContact = useCallback(() => {
    setContactId(null);
    setContact(null);
    setContactError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("connect");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  useEffect(() => {
    setContactId(
      parseContactLink(window.location.href, window.location.origin),
    );
  }, []);
  useEffect(() => {
    if (!me || !contactId) return;
    let active = true;
    setContact(null);
    setContactError("");
    if (contactId === me._id) {
      setContactError(
        "This is your contact link. Share it with someone else to connect.",
      );
      return;
    }
    request<User>("/users/" + contactId, undefined, me._id)
      .then((user) => {
        if (active) setContact(user);
      })
      .catch((error) => {
        if (active) setContactError(error.message);
      });
    return () => {
      active = false;
    };
  }, [contactId, me?._id]);
  const [mobileAccountActions, setMobileAccountActions] =
    useState<HTMLElement | null>(null);
  const [selectionActions, setSelectionActions] = useState<HTMLElement | null>(
    null,
  );
  useEffect(() => {
    let selectionTarget: HTMLElement | null = null;
    let target: HTMLElement | null = null;
    const connectActions = () => {
      if (target?.isConnected && selectionTarget?.isConnected) return;
      selectionTarget = document.getElementById("chat-selection-actions");
      setSelectionActions(selectionTarget);
      target = document.getElementById("mobile-account-actions");
      setMobileAccountActions(target);
    };
    // The shared controls can mount later or be replaced during navigation/HMR.
    const observer = new MutationObserver(connectActions);
    observer.observe(document.body, { childList: true, subtree: true });
    connectActions();
    return () => observer.disconnect();
  }, []);
  const profileButton = useRef<HTMLButtonElement>(null),
    mobileProfileButton = useRef<HTMLButtonElement>(null),
    profileClose = useRef<HTMLButtonElement>(null);
  const restoreProfileFocus = useCallback(() => {
    const mobileButton = mobileProfileButton.current;
    if (mobileButton?.getClientRects().length) mobileButton.focus();
    else {
      const more =
        document.querySelector<HTMLButtonElement>(".chat-more-button");
      if (more?.getClientRects().length) more.focus();
      else profileButton.current?.focus();
    }
  }, []);
  useEffect(() => {
    if (!showProfile) return;
    profileClose.current?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        setShowProfile(false);
        restoreProfileFocus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [showProfile, restoreProfileFocus]);
  const bottom = useRef<HTMLDivElement>(null),
    lastSelected = useRef<string | null>(null);
  const searchQuery = search.trim().toLowerCase();
  const visibleChats = !searchQuery
    ? chats
    : chats.filter((chat) => {
        if (chat.isGroup)
          return chat.chatName.toLowerCase().includes(searchQuery);
        const contact = chat.users.find((user) => user._id !== me?._id);
        return [contact?.name, contact?.email].some((value) =>
          value?.toLowerCase().includes(searchQuery),
        );
      });
  const active = chats.find((c) => c._id === selected) || null;
  const other = active?.users.find((u) => u._id !== me?._id);
  const accountDeleted =
    !!active &&
    !active.isGroup &&
    (!!active.accountPurgeAt || active.users.some((user) => !!user.deletedAt));
  const chatReadOnly = accountDeleted || !!active?.messagingBlocked;
  useEffect(() => {
    if (chatReadOnly) {
      setEditingMessage(null);
      setChatPhoto(null);
      setMessageSelection(new Set());
    }
  }, [chatReadOnly]);
  const title = active
    ? active.isGroup
      ? active.chatName
      : other?.name || "Conversation"
    : "Ping Me";
  const clearTimes = useRef(new Map<string, number>());
  useEffect(() => {
    clearTimes.current.clear();
  }, [me?._id]);
  const selectedRef = useRef(selected),
    userIdRef = useRef(me?._id);
  const sessionEpoch = useRef(0),
    chatRevision = useRef(0),
    messageRevision = useRef(0);
  selectedRef.current = selected;
  userIdRef.current = me?._id;
  const messageFeedback = useRef<{
    tracker: ReturnType<typeof createMessageSoundTracker>;
    player: ReturnType<typeof createMessageSoundPlayer>;
  } | null>(null);
  useEffect(() => {
    if (!me?._id) return;
    const feedback = {
      tracker: createMessageSoundTracker(me._id),
      player: createMessageSoundPlayer(),
    };
    messageFeedback.current = feedback;
    return () => {
      feedback.player.dispose();
      if (messageFeedback.current === feedback) messageFeedback.current = null;
    };
  }, [me?._id]);
  const expireSession = useCallback(() => {
    sessionEpoch.current++;
    userIdRef.current = undefined;
    clearTimes.current.clear();
    setMe(null);
    setSelected(null);
    setChats([]);
    setMessages([]);
    setSearch("");
    setShowProfile(false);
    setShowScanner(false);
    setShowGroup(false);
    setShowRename(false);
    setMobileChat(false);
    setShowSignOut(false);
    setError("Your session expired. Please sign in again.");
  }, []);
  const loadChats = useCallback(async () => {
    const id = userIdRef.current,
      epoch = sessionEpoch.current,
      revision = chatRevision.current;
    if (!id) return;
    let data: Chat[];
    try {
      data = await request<Chat[]>("/chats", undefined, id + ":" + epoch);
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status === 401 &&
        epoch === sessionEpoch.current
      )
        expireSession();
      throw error;
    }
    if (
      userIdRef.current === id &&
      sessionEpoch.current === epoch &&
      chatRevision.current === revision
    ) {
      const feedback = messageFeedback.current;
      if (feedback?.tracker.observe(data)) feedback.player.received();
      for (const chat of data) {
        if (chat.clearedAt)
          clearTimes.current.set(
            chat._id,
            Math.max(
              clearTimes.current.get(chat._id) || 0,
              Date.parse(chat.clearedAt),
            ),
          );
      }
      const selectedChatId = selectedRef.current;
      if (selectedChatId && !data.some((chat) => chat._id === selectedChatId)) {
        selectedRef.current = null;
        setSelected(null);
        setMessages([]);
        setMobileChat(false);
      }
      setChats(data);
    }
  }, [expireSession]);
  const loadMessages = useCallback(
    async (chatId: string) => {
      const id = userIdRef.current,
        epoch = sessionEpoch.current,
        revision = messageRevision.current;
      if (!id) return;
      let data: Message[];
      try {
        data = await request<Message[]>(
          "/messages/" + encodeURIComponent(chatId),
          undefined,
          id + ":" + epoch,
        );
      } catch (error) {
        if (
          error instanceof RequestError &&
          error.status === 401 &&
          epoch === sessionEpoch.current
        )
          expireSession();
        throw error;
      }
      if (
        userIdRef.current === id &&
        sessionEpoch.current === epoch &&
        selectedRef.current === chatId
      )
        setMessages((previous) =>
          (messageRevision.current === revision
            ? data
            : mergeMessages(data, previous)
          ).filter(
            (message) =>
              Date.parse(message.createdAt) >
              (clearTimes.current.get(chatId) || 0),
          ),
        );
    },
    [expireSession],
  );
  const upsertChat = useCallback((chat: Chat) => {
    chatRevision.current++;
    setChats((previous) =>
      [
        (() => {
          const current = previous.find((value) => value._id === chat._id);
          const merged = { ...current, ...chat };
          if (!chat.clearedAt && current?.clearedAt)
            merged.clearedAt = current.clearedAt;
          const cutoff = clearTimes.current.get(chat._id) || 0;
          if (
            merged.latestMessage &&
            Date.parse(merged.latestMessage.createdAt) <= cutoff
          )
            merged.latestMessage = undefined;
          return merged;
        })(),
        ...previous.filter((c) => c._id !== chat._id),
      ]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 100),
    );
  }, []);
  useEffect(() => {
    let active = true;
    request<User>("/auth/me")
      .then((u) => {
        if (active) setMe(u);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (selected) {
      if (lastSelected.current !== selected) {
        setMessages([]);
        lastSelected.current = selected;
      }
      loadMessages(selected).catch(() => {});
    } else {
      setMessages([]);
      lastSelected.current = null;
    }
  }, [selected, loadMessages]);
  useEffect(() => {
    const messageArea = bottom.current?.parentElement;
    messageArea?.scrollTo({
      top: messageArea.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, selected]);
  useEffect(() => {
    if (!me?._id) return;
    const sync = createChatSync({
      openSocket: () => createEventStream(),
      onSessionExpired: expireSession,
      refresh: async (chatIds) => {
        const chatId = selectedRef.current;
        await Promise.all([
          loadChats(),
          chatId && (!chatIds || chatIds.has(chatId))
            ? loadMessages(chatId)
            : Promise.resolve(),
        ]);
      },
      onLive: setWsActive,
      isVisible: () => document.visibilityState === "visible",
      isOnline: () => navigator.onLine,
    });
    const activityChanged = () => sync.activityChanged();
    document.addEventListener("visibilitychange", activityChanged);
    window.addEventListener("online", activityChanged);
    window.addEventListener("offline", activityChanged);
    sync.start();
    return () => {
      sync.stop();
      document.removeEventListener("visibilitychange", activityChanged);
      window.removeEventListener("online", activityChanged);
      window.removeEventListener("offline", activityChanged);
    };
  }, [me?._id, loadChats, loadMessages, expireSession]);
  useEffect(() => {
    if (!showGroup || !groupSearch.trim()) {
      setGroupResults([]);
      return;
    }
    const t = setTimeout(
      () =>
        request<User[]>("/users?search=" + encodeURIComponent(groupSearch))
          .then(setGroupResults)
          .catch(() => setGroupResults([])),
      250,
    );
    return () => clearTimeout(t);
  }, [groupSearch, showGroup]);
  async function authenticate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      const user = await request<User>("/auth/" + auth, {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      sessionEpoch.current++;
      setMe(user);
      setSearch("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await request("/auth/logout", { method: "POST" });
    sessionEpoch.current++;
    userIdRef.current = undefined;
    selectedRef.current = null;
    clearTimes.current.clear();
    setMe(null);
    setSelected(null);
    setChats([]);
    setMessages([]);
    setSearch("");
    setShowProfile(false);
    setShowScanner(false);
    setShowGroup(false);
    setShowRename(false);
    setShowSignOut(false);
    setMobileChat(false);
    setError("");
  }
  async function startChat(id: string) {
    setError("");
    try {
      const epoch = sessionEpoch.current;
      const chat = await request<Chat>("/chats", {
        method: "POST",
        body: JSON.stringify({ userId: id }),
      });
      if (epoch !== sessionEpoch.current) return;
      upsertChat(chat);
      setSelected(chat._id);
      setMobileChat(true);
      setSearch("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !compose.trim() || busy || chatReadOnly) return;
    const content = compose.trim();
    if (editingMessage) {
      if (
        content === editingMessage.message.content ||
        selected !== editingMessage.chatId
      )
        return;
      const editing = editingMessage,
        epoch = sessionEpoch.current;
      setBusy(true);
      setError("");
      try {
        await changeMessage(editing.message, content);
        if (
          epoch === sessionEpoch.current &&
          selectedRef.current === editing.chatId
        ) {
          setCompose(editing.previousDraft);
          setEditingMessage(null);
        }
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Could not edit message",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    setCompose("");
    setBusy(true);
    try {
      const epoch = sessionEpoch.current;
      const chatId = selected;
      const message = await request<Message>("/messages", {
        method: "POST",
        body: JSON.stringify({ chatId, content }),
      });
      if (epoch !== sessionEpoch.current) return;
      messageFeedback.current?.tracker.sent(chatId, message);
      messageFeedback.current?.player.sent();
      messageRevision.current++;
      chatRevision.current++;
      if (selectedRef.current === chatId)
        setMessages((previous) =>
          previous.some((m) => m._id === message._id)
            ? previous
            : [...previous, message],
        );
      setChats((previous) =>
        previous
          .map((c) =>
            c._id === chatId
              ? { ...c, latestMessage: message, updatedAt: message.createdAt }
              : c,
          )
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      );
    } catch (e) {
      setCompose(content);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeMessage(message: Message, content?: string) {
    const chatId = selectedRef.current;
    const epoch = sessionEpoch.current;
    if (!chatId) throw new Error("Please open the conversation again");
    const updated = await request<Message>(
      "/messages/" +
        encodeURIComponent(chatId) +
        "/" +
        encodeURIComponent(message._id),
      {
        method: content === undefined ? "DELETE" : "PATCH",
        ...(content === undefined ? {} : { body: JSON.stringify({ content }) }),
      },
    );
    if (epoch !== sessionEpoch.current) return;
    messageRevision.current++;
    chatRevision.current++;
    if (selectedRef.current === chatId)
      setMessages((previous) =>
        previous.map((item) => (item._id === updated._id ? updated : item)),
      );
    setChats((previous) =>
      previous.map((chat) =>
        chat._id === chatId && chat.latestMessage?._id === updated._id
          ? { ...chat, latestMessage: updated }
          : chat,
      ),
    );
  }
  async function deleteSelectedMessages(targets: Message[]) {
    const chatId = selectedRef.current;
    const epoch = sessionEpoch.current;
    if (!chatId) throw new Error("Please open the conversation again");
    const updated = await request<Message[]>(
      "/messages/" + encodeURIComponent(chatId),
      {
        method: "DELETE",
        body: JSON.stringify({
          messageIds: targets.map((message) => message._id),
        }),
      },
    );
    if (epoch !== sessionEpoch.current) return;
    const byId = new Map(updated.map((message) => [message._id, message]));
    messageRevision.current++;
    chatRevision.current++;
    if (selectedRef.current === chatId)
      setMessages((previous) =>
        previous.map((message) => byId.get(message._id) || message),
      );
    setChats((previous) =>
      previous.map((chat) =>
        chat._id === chatId &&
        chat.latestMessage &&
        byId.has(chat.latestMessage._id)
          ? { ...chat, latestMessage: byId.get(chat.latestMessage._id)! }
          : chat,
      ),
    );
    setMessageSelection(new Set());
  }
  async function sendImage(file: File) {
    const target = chatPhoto;
    if (chatReadOnly)
      throw new Error("Messaging is unavailable for this conversation");
    if (
      !target ||
      target.epoch !== sessionEpoch.current ||
      target.chatId !== selectedRef.current
    )
      throw new Error("Please open the conversation again");
    const compressed = await compressImage(file, {
      maxWidth: 1024,
      quality: 0.8,
      thresholdKB: 200,
    });
    const form = new FormData();
    form.set("chatId", target.chatId);
    form.set("image", compressed);
    const message = await request<Message>("/messages/image", {
      method: "POST",
      body: form,
    });
    if (target.epoch !== sessionEpoch.current) return;
    messageFeedback.current?.tracker.sent(target.chatId, message);
    messageFeedback.current?.player.sent();
    messageRevision.current++;
    chatRevision.current++;
    if (target.chatId === selectedRef.current)
      setMessages((previous) => [
        ...previous.filter((item) => item._id !== message._id),
        message,
      ]);
    setChats((previous) =>
      previous
        .map((chat) =>
          chat._id === target.chatId
            ? { ...chat, latestMessage: message, updatedAt: message.createdAt }
            : chat,
        )
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    );
  }
  async function confirmChatAction(target: {
    action: ChatActionType;
    chatId: string;
    name: string;
  }) {
    const epoch = sessionEpoch.current;
    const result = await request<{
      clearedAt?: string;
      blockedByMe?: boolean;
      messagingBlocked?: boolean;
    }>("/chats/" + target.chatId + "/actions", {
      method: "POST",
      body: JSON.stringify({ action: target.action }),
    });
    if (epoch !== sessionEpoch.current) return;
    messageRevision.current++;
    chatRevision.current++;
    if (target.action === "clear") {
      const clearedAt = result.clearedAt!;
      clearTimes.current.set(target.chatId, Date.parse(clearedAt));
      if (selectedRef.current === target.chatId) {
        setMessages([]);
        setEditingMessage(null);
        setMessageSelection(new Set());
      }
      setChats((previous) =>
        previous.map((chat) =>
          chat._id === target.chatId
            ? { ...chat, clearedAt, latestMessage: undefined }
            : chat,
        ),
      );
    } else if (target.action === "leave" || target.action === "delete-group") {
      setChats((previous) =>
        previous.filter((chat) => chat._id !== target.chatId),
      );
      if (selectedRef.current === target.chatId) {
        selectedRef.current = null;
        setSelected(null);
        setMessages([]);
        setMobileChat(false);
      }
    } else {
      setChats((previous) =>
        previous.map((chat) =>
          chat._id === target.chatId
            ? {
                ...chat,
                blockedByMe: result.blockedByMe,
                messagingBlocked: result.messagingBlocked,
              }
            : chat,
        ),
      );
    }
  }
  async function createGroup() {
    setError("");
    try {
      const epoch = sessionEpoch.current;
      const chat = await request<Chat>("/chats/group", {
        method: "POST",
        body: JSON.stringify({ name: groupName, users: groupMembers }),
      });
      if (epoch !== sessionEpoch.current) return;
      upsertChat(chat);
      setSelected(chat._id);
      setShowGroup(false);
      setGroupName("");
      setGroupMembers([]);
      setGroupSearch("");
      setMobileChat(true);
      setSearch("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function renameGroup() {
    if (!active) return;
    try {
      const epoch = sessionEpoch.current;
      const chat = await request<Chat>("/chats/rename", {
        method: "PUT",
        body: JSON.stringify({ chatId: active._id, chatName: rename }),
      });
      if (epoch !== sessionEpoch.current) return;
      upsertChat(chat);
      const activity = chat.activityMessage;
      if (activity) {
        messageRevision.current++;
        messageFeedback.current?.tracker.sent(chat._id, activity);
        if (selectedRef.current === chat._id)
          setMessages((previous) =>
            mergeMessages([activity], previous).filter(
              (message) =>
                Date.parse(message.createdAt) >
                (clearTimes.current.get(chat._id) || 0),
            ),
          );
      }
      setShowRename(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (loading) return <OpeningLoader />;
  if (!me)
    return (
      <main className="authscreen">
        <section className="authhero">
          <div className="brand">
            <span className="brandmark">
              <AppLogo />
            </span>
            <span>Ping Me</span>
          </div>
          <h1>
            Better conversations.
            <br />
            <em>Closer connections.</em>
          </h1>
          <p>A calm, modern place to keep your favorite people close.</p>
          <div className="herobubble b1">
            Hey! Are we still on for today? ✨
          </div>
          <div className="herobubble b2">Absolutely! See you soon 🙌</div>
        </section>
        <section className="authpane">
          <form className="authcard" onSubmit={authenticate}>
            <div className="eyebrow">WELCOME TO PING ME</div>
            {contactId && (
              <p className="contact-signin-note">
                Sign in or create an account to connect with this person.
              </p>
            )}
            <h2>{auth === "login" ? "Welcome back" : "Create your account"}</h2>
            <p>
              {auth === "login"
                ? "Sign in to continue your conversations."
                : "Your next great conversation starts here."}
            </p>
            {auth === "register" && (
              <label>
                Full name
                <input
                  name="name"
                  placeholder="Your name"
                  minLength={2}
                  maxLength={80}
                  required
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                placeholder="At least 8 characters"
                minLength={auth === "register" ? 8 : 1}
                required
                autoComplete={
                  auth === "login" ? "current-password" : "new-password"
                }
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary wide" disabled={busy}>
              {busy
                ? "Please wait..."
                : auth === "login"
                  ? "Sign in"
                  : "Create account"}
            </button>
            <div className="authswitch">
              {auth === "login"
                ? "New to Ping Me?"
                : "Already have an account?"}{" "}
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setAuth(auth === "login" ? "register" : "login");
                }}
              >
                {auth === "login" ? "Create an account" : "Sign in"}
              </button>
            </div>
          </form>
        </section>
      </main>
    );
  return (
    <main className="shell" data-chat-open={mobileChat}>
      {showSignOut && (
        <SignOutDialog
          onConfirm={logout}
          onClose={() => setShowSignOut(false)}
        />
      )}
      {chatAction && (
        <ChatActionDialog
          action={chatAction.action}
          name={chatAction.name}
          onClose={() => setChatAction(null)}
          onConfirm={() => confirmChatAction(chatAction)}
        />
      )}
      {chatPhoto && (
        <ChatImageEditor
          file={chatPhoto.file}
          onSave={sendImage}
          onClose={() => setChatPhoto(null)}
        />
      )}
      {messageAction && (
        <MessageActionDialog
          messages={messageAction.messages}
          onClose={() => setMessageAction(null)}
          onConfirm={() => deleteSelectedMessages(messageAction.messages)}
        />
      )}
      {selectionActions &&
        selectionMode &&
        createPortal(
          <>
            {!chatReadOnly &&
              selectedMessages.length === 1 &&
              selectedMessages[0].kind !== "image" &&
              selectedMessages[0].kind !== "group-rename" && (
                <button
                  type="button"
                  className="circlebtn"
                  aria-label="Edit selected message"
                  title="Edit message"
                  onClick={() => startEditing(selectedMessages[0])}
                >
                  <Pencil size={18} />
                </button>
              )}
            <button
              type="button"
              className="circlebtn selection-delete"
              aria-label="Delete selected messages"
              title="Delete selected messages"
              onClick={() =>
                setMessageAction({
                  action: "delete",
                  messages: selectedMessages,
                })
              }
            >
              <Trash2 size={18} />
            </button>
          </>,
          selectionActions,
        )}
      {previewUser?.image && (
        <PhotoPreview
          image={previewUser.image}
          name={previewUser.name}
          onClose={() => setPreviewUser(null)}
        />
      )}
      {mobileAccountActions &&
        createPortal(
          <>
            <button
              ref={mobileProfileButton}
              className="control-button"
              type="button"
              title="Your account"
              aria-label="Open your account"
              onClick={() => setShowProfile(true)}
            >
              <UserRound size={19} />
            </button>
            {active?.isGroup && active.groupAdmin?._id === me._id && (
              <button
                className="control-button"
                type="button"
                aria-label="Rename group"
                onClick={() => {
                  setRename(active.chatName);
                  setShowRename(true);
                }}
              >
                <Users size={19} />
              </button>
            )}
            {active && (
              <>
                <button
                  className="control-button"
                  type="button"
                  aria-label={
                    active.isGroup ? "Clear group chat" : "Clear chat"
                  }
                  onClick={() =>
                    setChatAction({
                      action: "clear",
                      chatId: active._id,
                      name: title,
                    })
                  }
                >
                  <Eraser size={19} />
                </button>
                {active.isGroup &&
                  active.users.length === 1 &&
                  active.users[0]._id === me._id && (
                    <button
                      className="control-button menu-danger"
                      type="button"
                      aria-label="Delete group"
                      onClick={() =>
                        setChatAction({
                          action: "delete-group",
                          chatId: active._id,
                          name: title,
                        })
                      }
                    >
                      <Trash2 size={19} />
                    </button>
                  )}
                {active.isGroup ? (
                  <button
                    className="control-button menu-danger"
                    type="button"
                    aria-label="Leave group"
                    onClick={() =>
                      setChatAction({
                        action: "leave",
                        chatId: active._id,
                        name: title,
                      })
                    }
                  >
                    <LeaveGroupIcon size={19} />
                  </button>
                ) : (
                  !accountDeleted && (
                    <button
                      className="control-button menu-danger"
                      type="button"
                      aria-label={
                        active.blockedByMe ? "Unblock user" : "Block user"
                      }
                      onClick={() =>
                        setChatAction({
                          action: active.blockedByMe ? "unblock" : "block",
                          chatId: active._id,
                          name: title,
                        })
                      }
                    >
                      <Ban size={19} />
                    </button>
                  )
                )}
              </>
            )}
            <button
              className="control-button"
              type="button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => setShowSignOut(true)}
            >
              <LogOut size={19} />
            </button>
          </>,
          mobileAccountActions,
        )}
      <aside className={"sidebar " + (mobileChat ? "mobile-hidden" : "")}>
        <header className="sidehead">
          <button
            type="button"
            className="brand brand-home"
            aria-label="Go to start screen"
            title="Go to start screen"
            onClick={() => {
              selectedRef.current = null;
              messageRevision.current++;
              setSelected(null);
              setMessages([]);
              setMobileChat(false);
              setSearch("");
              setError("");
            }}
          >
            <span className="brandmark small">
              <AppLogo />
            </span>
            <span>Ping Me</span>
          </button>
          <button
            className="circlebtn desktop-signout"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => setShowSignOut(true)}
          >
            <LogOut size={19} />
          </button>
        </header>
        <button
          ref={profileButton}
          type="button"
          className="myprofile profile-trigger"
          aria-label="Open your profile"
          onClick={() => setShowProfile(true)}
        >
          <Avatar user={me} />
          <div>
            <strong>{me.name}</strong>
            <small>{me.email}</small>
          </div>
          <span className="online" title="Signed in" />
        </button>
        <div className="listheading">
          <div>
            <h2>Messages</h2>
            <p>Stay close, wherever you are</p>
          </div>
          <button
            title="Create group"
            aria-label="Create group"
            className="circlebtn add"
            onClick={() => setShowGroup(true)}
          >
            <Users size={22} />
          </button>
        </div>
        <div className="searchbox">
          <Search size={18} />
          <button
            ref={scanButton}
            type="button"
            className="scan-contact-button"
            title="Scan contact QR code"
            aria-label="Scan contact QR code"
            onClick={() => setShowScanner(true)}
          >
            <QrCode size={20} />
          </button>
          <input
            placeholder="Search recent chats..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search recent chats"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="scrolllist">
          <>
            <div className="sectionlabel">
              RECENT CHATS <span>{visibleChats.length}</span>
            </div>
            {visibleChats.length ? (
              visibleChats.map((c) => {
                const user = c.users.find((u) => u._id !== me._id);
                return (
                  <button
                    key={c._id}
                    className={
                      "chatentry " + (selected === c._id ? "active" : "")
                    }
                    onClick={() => {
                      setSelected(c._id);
                      setMobileChat(true);
                    }}
                  >
                    <Avatar
                      user={
                        c.isGroup
                          ? { _id: c._id, name: c.chatName, email: "" }
                          : user
                      }
                    />
                    <div className="entrytext">
                      <strong>
                        {c.isGroup ? c.chatName : user?.name || "Conversation"}
                      </strong>
                      <small>
                        {(c.latestMessage ? (
                          <MessagePreview message={c.latestMessage} />
                        ) : null) ||
                          (c.clearedAt
                            ? "Chat cleared"
                            : c.isGroup
                              ? `${c.users.length} members`
                              : "Start a conversation")}
                      </small>
                    </div>
                    <time>
                      {c.latestMessage?.createdAt
                        ? new Date(
                            c.latestMessage.createdAt,
                          ).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
                    </time>
                  </button>
                );
              })
            ) : (
              <div className="emptylist">
                <MessageCircle size={30} />
                <strong>
                  {search.trim() ? "No matching chats" : "No chats yet"}
                </strong>
                <span>
                  {search.trim()
                    ? "Try another name, or use the QR button to connect."
                    : "Use the QR button to connect with someone new."}
                </span>
              </div>
            )}
          </>
        </div>
        <footer className="sidefoot">
          <span className={"statusdot " + (wsActive ? "connected" : "")} />
          {wsActive ? "Live connection" : "Checking for updates"}
          <ShieldCheck size={15} />
        </footer>
      </aside>
      <section
        className={"conversation " + (!mobileChat ? "mobile-hidden" : "")}
      >
        {active ? (
          <>
            <header
              className={
                "conversationhead" +
                (selectionMode ? " selecting-messages" : "")
              }
            >
              <button
                className={
                  (selectionMode ? "selection-cancel" : "mobileback") +
                  " circlebtn"
                }
                aria-label={
                  selectionMode
                    ? "Cancel message selection"
                    : "Back to conversations"
                }
                onClick={() =>
                  selectionMode
                    ? setMessageSelection(new Set())
                    : setMobileChat(false)
                }
              >
                {selectionMode ? <X size={20} /> : <ArrowLeft />}
              </button>
              {!selectionMode &&
                (!active.isGroup && other?.image ? (
                  <button
                    type="button"
                    className="avatar-preview-trigger"
                    aria-label={"View " + other.name + "'s profile photo"}
                    onClick={() => setPreviewUser(other)}
                  >
                    <Avatar user={other} />
                  </button>
                ) : (
                  <Avatar
                    user={
                      active.isGroup
                        ? { _id: active._id, name: title, email: "" }
                        : other
                    }
                  />
                ))}
              <div className="conversation-identity">
                <strong title={title}>
                  {selectionMode
                    ? selectedMessages.length + " selected"
                    : title}
                </strong>
                <small hidden={selectionMode}>
                  {active.isGroup
                    ? `${active.users.length} group members`
                    : accountDeleted
                      ? "User account deleted"
                      : other?.email || "Private conversation"}
                </small>
              </div>
              {!selectionMode &&
                active.isGroup &&
                active.groupAdmin?._id === me._id && (
                  <button
                    className="renamebtn chat-rename"
                    onClick={() => {
                      setRename(active.chatName);
                      setShowRename(true);
                    }}
                  >
                    Rename <ChevronDown size={14} />
                  </button>
                )}
            </header>
            <div className="messagearea">
              {messages.length ? (
                messages.map((m) => (
                  <div
                    key={m._id}
                    data-message-id={m._id}
                    className={
                      "msgrow " + (m.sender._id === me._id ? "own" : "theirs")
                    }
                  >
                    <MessageBubble
                      message={m}
                      own={m.sender._id === me._id}
                      group={active.isGroup}
                      selected={messageSelection.has(m._id)}
                      selecting={selectionMode}
                      onSelect={toggleMessage}
                    />
                  </div>
                ))
              ) : (
                <div className="chatwelcome">
                  <span className="welcomeicon">
                    <MessageCircle size={34} />
                  </span>
                  <h3>
                    {active.clearedAt
                      ? "Chat cleared"
                      : "It's the beginning of something good"}
                  </h3>
                  <p>
                    {active.clearedAt
                      ? "New messages will appear here. Other participants keep their history."
                      : "Say hello and get the conversation going."}
                  </p>
                </div>
              )}
              <div ref={bottom} />
            </div>
            <form
              className={
                "composer" +
                (editingMessage ? " is-editing" : "") +
                (chatReadOnly ? " account-deleted-composer" : "")
              }
              onSubmit={send}
            >
              {accountDeleted && (
                <p className="account-history-warning" role="status">
                  User account deleted.{" "}
                  {active.accountPurgeAt
                    ? "This chat history will be removed on " +
                      new Date(active.accountPurgeAt).toLocaleDateString() +
                      " (15 days after account deletion)."
                    : "This chat history will be removed 15 days after account deletion."}
                </p>
              )}
              {!accountDeleted && active.messagingBlocked && (
                <p className="account-history-warning" role="status">
                  {active.blockedByMe
                    ? "You blocked this user. Unblock them from More options to chat again."
                    : "Messaging is unavailable for this contact."}
                </p>
              )}
              {editingMessage && (
                <div className="composer-edit-banner">
                  <Pencil size={15} />
                  <span>Editing message</span>
                  <button
                    type="button"
                    className="circlebtn"
                    aria-label="Cancel editing"
                    title="Cancel editing"
                    disabled={busy}
                    onClick={cancelEditing}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              {!editingMessage && (
                <>
                  <button
                    type="button"
                    className="circlebtn attach-image"
                    aria-label="Send image"
                    title="Send image"
                    disabled={busy || chatReadOnly}
                    onClick={() => chatPhotoInput.current?.click()}
                  >
                    <ImagePlus size={20} />
                  </button>
                  <input
                    ref={chatPhotoInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    aria-label="Choose chat image"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file || !selected) return;
                      if (
                        !["image/jpeg", "image/png", "image/webp"].includes(
                          file.type,
                        )
                      ) {
                        setError("Choose a JPEG, PNG or WebP image");
                        return;
                      }
                      if (file.size > 12 * 1024 * 1024) {
                        setError("Choose an image smaller than 12 MB");
                        return;
                      }
                      setError("");
                      setChatPhoto({
                        file,
                        chatId: selected,
                        epoch: sessionEpoch.current,
                      });
                    }}
                  />
                </>
              )}
              <input
                ref={composerInput}
                disabled={chatReadOnly || (!!editingMessage && busy)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && editingMessage) {
                    event.preventDefault();
                    cancelEditing();
                  }
                }}
                placeholder={
                  accountDeleted
                    ? "User account deleted"
                    : active.messagingBlocked
                      ? active.blockedByMe
                        ? "You blocked this user"
                        : "Messaging unavailable"
                      : editingMessage
                        ? "Edit your message..."
                        : "Write a message..."
                }
                value={compose}
                onChange={(e) => setCompose(e.target.value)}
                maxLength={4000}
                aria-label={editingMessage ? "Edit message text" : "Message"}
              />
              <button
                className="sendbtn"
                type="submit"
                disabled={
                  chatReadOnly ||
                  !compose.trim() ||
                  busy ||
                  (!!editingMessage &&
                    compose.trim() === editingMessage.message.content)
                }
                aria-label={
                  editingMessage ? "Save message changes" : "Send message"
                }
                title={editingMessage ? "Save changes" : "Send message"}
              >
                {editingMessage ? <Check size={19} /> : <Send size={19} />}
              </button>
            </form>
          </>
        ) : (
          <div className="nochats">
            <span className="splashicon">
              <MessageCircle size={48} />
            </span>
            <h2>Your conversations, all in one place.</h2>
            <p>
              Select a recent chat or use the QR button to connect with someone
              new.
            </p>
            <div className="securitynote">
              <ShieldCheck size={17} /> Protected account access
            </div>
          </div>
        )}
      </section>
      {error && me && (
        <div role="alert" className="toast">
          <span>{error}</span>
          <button aria-label="Dismiss" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {showProfile && (
        <ProfilePanel
          user={me}
          closeButtonRef={profileClose}
          onClose={() => {
            setShowProfile(false);
            restoreProfileFocus();
          }}
          onDeleted={() => {
            expireSession();
            setError("Your account has been deleted.");
          }}
          onSignOut={() => setShowSignOut(true)}
          onUpdated={(updated) => {
            if (userIdRef.current !== updated._id) return;
            setMe(updated);
            chatRevision.current++;
            messageRevision.current++;
            setChats((previous) =>
              previous.map((chat) => ({
                ...chat,
                users: chat.users.map((user) =>
                  user._id === updated._id ? updated : user,
                ),
                groupAdmin:
                  chat.groupAdmin?._id === updated._id
                    ? updated
                    : chat.groupAdmin,
              })),
            );
            setMessages((previous) =>
              previous.map((message) =>
                message.sender._id === updated._id
                  ? { ...message, sender: updated }
                  : message,
              ),
            );
          }}
        />
      )}
      {showScanner && (
        <ContactScanner
          onClose={() => {
            setShowScanner(false);
            scanButton.current?.focus();
          }}
          onContact={(id) => {
            setShowScanner(false);
            setContactId(id);
          }}
        />
      )}
      {contactId && (
        <div
          className="overlay contact-preview-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !connecting)
              clearContact();
          }}
        >
          <section
            className="modal contact-preview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-title"
          >
            <div className="modalhead">
              <h3 id="contact-title">Connect on Ping Me</h3>
              <button
                className="circlebtn"
                aria-label="Close contact preview"
                disabled={connecting}
                onClick={clearContact}
              >
                <X size={20} />
              </button>
            </div>
            {contactError ? (
              <p className="error" role="alert">
                {contactError}
              </p>
            ) : contact ? (
              <>
                <div className="contact-preview-person">
                  <Avatar user={contact} large />
                  <h4>{contact.name}</h4>
                  {contact.bio && <p>{contact.bio}</p>}
                </div>
                <button
                  className="primary wide"
                  disabled={connecting}
                  onClick={async () => {
                    setConnecting(true);
                    try {
                      if (await startChat(contact._id)) clearContact();
                    } finally {
                      setConnecting(false);
                    }
                  }}
                >
                  {connecting ? "Connecting?" : "Start conversation"}
                </button>
              </>
            ) : (
              <p role="status" className="profile-helper">
                Loading contact?
              </p>
            )}
          </section>
        </div>
      )}
      {showGroup && (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowGroup(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create group"
          >
            <div className="modalhead">
              <h3>New group</h3>
              <button className="circlebtn" onClick={() => setShowGroup(false)}>
                <X />
              </button>
            </div>
            <p>Bring your people together in one conversation.</p>
            <label>
              Group name
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. Weekend plans"
                maxLength={100}
              />
            </label>
            <label>
              Add members{" "}
              <small>({groupMembers.length} selected, minimum 2)</small>
              <input
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                placeholder="Search by name or email"
              />
            </label>
            <div className="modalpeople">
              {groupResults.length ? (
                groupResults.map((u) => (
                  <button
                    key={u._id}
                    className="personrow"
                    onClick={() =>
                      setGroupMembers((a) =>
                        a.includes(u._id)
                          ? a.filter((i) => i !== u._id)
                          : [...a, u._id],
                      )
                    }
                  >
                    <Avatar user={u} />
                    <span>{u.name}</span>
                    <span
                      className={
                        "check " +
                        (groupMembers.includes(u._id) ? "checked" : "")
                      }
                    >
                      {groupMembers.includes(u._id) && <Check size={14} />}
                    </span>
                  </button>
                ))
              ) : (
                <div className="hint">
                  Search for people above and select at least two members.
                </div>
              )}
            </div>
            <button
              className="primary wide"
              disabled={!groupName.trim() || groupMembers.length < 2}
              onClick={createGroup}
            >
              Create group
            </button>
          </div>
        </div>
      )}
      {showRename && (
        <div className="overlay">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Rename group"
          >
            <div className="modalhead">
              <h3>Rename group</h3>
              <button
                className="circlebtn"
                onClick={() => setShowRename(false)}
              >
                <X />
              </button>
            </div>
            <label>
              Group name
              <input
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                maxLength={100}
              />
            </label>
            <button
              className="primary wide"
              disabled={!rename.trim()}
              onClick={renameGroup}
            >
              Save name
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
