"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ProfilePanel from "./ProfilePanel";
import OpeningLoader from "./OpeningLoader";
import ContactScanner from "./ContactScanner";
import { parseContactLink, type ContactUser } from "@/lib/contacts";
import {
  createChatSync,
  createReadDeduper,
  mergeMessages,
} from "@/lib/chat-sync";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  LogOut,
  Menu,
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
type Message = {
  _id: string;
  sender: User;
  content: string;
  createdAt: string;
};
type Chat = {
  _id: string;
  chatName: string;
  isGroup: boolean;
  users: User[];
  groupAdmin?: User;
  latestMessage?: Message;
  updatedAt: string;
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
      headers: { "Content-Type": "application/json", ...options?.headers },
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
  const [me, setMe] = useState<User | null>(null),
    [auth, setAuth] = useState<"login" | "register">("login"),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState(""),
    [found, setFound] = useState<User[]>([]),
    [groupSearch, setGroupSearch] = useState(""),
    [groupResults, setGroupResults] = useState<User[]>([]),
    [compose, setCompose] = useState(""),
    [showGroup, setShowGroup] = useState(false),
    [groupName, setGroupName] = useState(""),
    [groupMembers, setGroupMembers] = useState<string[]>([]),
    [showRename, setShowRename] = useState(false),
    [rename, setRename] = useState("");
  const [mobileChat, setMobileChat] = useState(false),
    [wsActive, setWsActive] = useState(false);
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
  useEffect(() => {
    setMobileAccountActions(document.getElementById("mobile-account-actions"));
  }, []);
  const profileButton = useRef<HTMLButtonElement>(null),
    mobileProfileButton = useRef<HTMLButtonElement>(null),
    profileClose = useRef<HTMLButtonElement>(null);
  const restoreProfileFocus = useCallback(() => {
    const mobileButton = mobileProfileButton.current;
    if (mobileButton?.getClientRects().length) mobileButton.focus();
    else profileButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!showProfile) return;
    profileClose.current?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowProfile(false);
        restoreProfileFocus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [showProfile, restoreProfileFocus]);
  const bottom = useRef<HTMLDivElement>(null),
    lastSelected = useRef<string | null>(null);
  const active = chats.find((c) => c._id === selected) || null;
  const other = active?.users.find((u) => u._id !== me?._id);
  const title = active
    ? active.isGroup
      ? active.chatName
      : other?.name || "Conversation"
    : "Ping Me";
  const selectedRef = useRef(selected),
    userIdRef = useRef(me?._id);
  const sessionEpoch = useRef(0),
    chatRevision = useRef(0),
    messageRevision = useRef(0);
  selectedRef.current = selected;
  userIdRef.current = me?._id;
  const expireSession = useCallback(() => {
    sessionEpoch.current++;
    userIdRef.current = undefined;
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
    )
      setChats(data);
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
          messageRevision.current === revision
            ? data
            : mergeMessages(data, previous),
        );
    },
    [expireSession],
  );
  const upsertChat = useCallback((chat: Chat) => {
    chatRevision.current++;
    setChats((previous) =>
      [chat, ...previous.filter((c) => c._id !== chat._id)]
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
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selected]);
  useEffect(() => {
    if (!me?._id) return;
    const sync = createChatSync({
      openSocket: () =>
        new WebSocket(
          (location.protocol === "https:" ? "wss:" : "ws:") +
            "//" +
            location.host +
            "/api/ws",
        ),
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
  }, [me?._id, loadChats, loadMessages]);
  useEffect(() => {
    if (!search.trim() || !me) {
      setFound([]);
      return;
    }
    const timer = setTimeout(
      () =>
        request<User[]>("/users?search=" + encodeURIComponent(search))
          .then(setFound)
          .catch(() => setFound([])),
      250,
    );
    return () => clearTimeout(timer);
  }, [search, me]);
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
    sessionEpoch.current++;
    await request("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
    setSelected(null);
    setChats([]);
    setMessages([]);
    setSearch("");
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
    if (!selected || !compose.trim() || busy) return;
    const content = compose.trim();
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
              <MessageCircle size={27} />
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
    <main className="shell">
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
            <button
              className="control-button"
              type="button"
              title="Sign out"
              aria-label="Sign out"
              onClick={logout}
            >
              <LogOut size={19} />
            </button>
          </>,
          mobileAccountActions,
        )}
      <aside className={"sidebar " + (mobileChat ? "mobile-hidden" : "")}>
        <header className="sidehead">
          <div className="brand">
            <span className="brandmark small">
              <MessageCircle size={22} />
            </span>
            <span>Ping Me</span>
          </div>
          <button
            className="circlebtn desktop-signout"
            title="Sign out"
            aria-label="Sign out"
            onClick={logout}
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
            placeholder="Search people..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search users"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="scrolllist">
          {search.trim() ? (
            <>
              <div className="sectionlabel">PEOPLE</div>
              {found.length ? (
                found.map((u) => (
                  <button
                    key={u._id}
                    className="chatentry"
                    onClick={() => {
                      if (showGroup) {
                        setGroupMembers((a) =>
                          a.includes(u._id)
                            ? a.filter((i) => i !== u._id)
                            : [...a, u._id],
                        );
                      } else startChat(u._id);
                    }}
                  >
                    <Avatar user={u} />
                    <div className="entrytext">
                      <strong>{u.name}</strong>
                      <small>{u.email}</small>
                    </div>
                    {groupMembers.includes(u._id) && <Check size={17} />}
                  </button>
                ))
              ) : (
                <p className="emptylist">No matching people found</p>
              )}
            </>
          ) : (
            <>
              <div className="sectionlabel">
                RECENT CHATS <span>{chats.length}</span>
              </div>
              {chats.length ? (
                chats.map((c) => {
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
                          {c.isGroup
                            ? c.chatName
                            : user?.name || "Conversation"}
                        </strong>
                        <small>
                          {c.latestMessage?.content ||
                            (c.isGroup
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
                  <strong>No chats yet</strong>
                  <span>Search for someone to say hello!</span>
                </div>
              )}
            </>
          )}
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
            <header className="conversationhead">
              <button
                className="mobileback circlebtn"
                aria-label="Back to conversations"
                onClick={() => setMobileChat(false)}
              >
                <ArrowLeft />
              </button>
              <Avatar
                user={
                  active.isGroup
                    ? { _id: active._id, name: title, email: "" }
                    : other
                }
              />
              <div>
                <strong>{title}</strong>
                <small>
                  {active.isGroup
                    ? `${active.users.length} group members`
                    : other?.email || "Private conversation"}
                </small>
              </div>
              {active.isGroup && active.groupAdmin?._id === me._id && (
                <button
                  className="renamebtn"
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
                    className={
                      "msgrow " + (m.sender._id === me._id ? "own" : "theirs")
                    }
                  >
                    <div className="bubble">
                      {active.isGroup && m.sender._id !== me._id && (
                        <b>{m.sender.name}</b>
                      )}
                      <p>{m.content}</p>
                      <time>
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </div>
                ))
              ) : (
                <div className="chatwelcome">
                  <span className="welcomeicon">
                    <MessageCircle size={34} />
                  </span>
                  <h3>It's the beginning of something good</h3>
                  <p>Say hello and get the conversation going.</p>
                </div>
              )}
              <div ref={bottom} />
            </div>
            <form className="composer" onSubmit={send}>
              <input
                placeholder="Write a message..."
                value={compose}
                onChange={(e) => setCompose(e.target.value)}
                maxLength={4000}
                aria-label="Message"
              />
              <button
                className="sendbtn"
                type="submit"
                disabled={!compose.trim() || busy}
                title="Send message"
              >
                <Send size={19} />
              </button>
            </form>
          </>
        ) : (
          <div className="nochats">
            <span className="splashicon">
              <MessageCircle size={48} />
            </span>
            <h2>Your conversations, all in one place.</h2>
            <p>Select a chat or search for someone to start talking.</p>
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
          onSignOut={() => {
            setShowProfile(false);
            void logout();
          }}
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
