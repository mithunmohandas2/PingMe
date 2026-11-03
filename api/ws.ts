import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import { jwtVerify } from "jose";
import { connectDb } from "../src/lib/db";
import { User } from "../src/lib/models";
const server = createServer((_, res) => {
  res.writeHead(426);
  res.end("WebSocket upgrade required");
});
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<WebSocket, string>();
const secret = process.env.JWT_SECRET;
let subscriber: Redis | undefined;
let subscribed = false;
function sendStatus(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(
      JSON.stringify({
        type: "sync:status",
        live: subscribed && subscriber?.status === "ready",
      }),
    );
}
function broadcastStatus() {
  for (const socket of sessions.keys()) sendStatus(socket);
}
if (process.env.REDIS_URL) {
  subscriber = new Redis(process.env.REDIS_URL);
  subscriber.on("ready", () => {
    subscriber!
      .subscribe("pingme:events")
      .then(() => {
        subscribed = true;
        broadcastStatus();
      })
      .catch((e) => {
        subscribed = false;
        broadcastStatus();
        console.error("Realtime subscription failed", e);
      });
  });
  subscriber.on("close", () => {
    subscribed = false;
    broadcastStatus();
  });
  subscriber.on("error", (e) => {
    subscribed = false;
    broadcastStatus();
    console.error("Realtime subscriber error", e);
  });
  subscriber.on("message", (_channel, payload) => {
    try {
      const event = JSON.parse(payload);
      if (event.type === "session:revoke") {
        for (const [socket, userId] of sessions)
          if (userId === event.userId) socket.close(4001, "Session updated");
        return;
      }
      for (const [socket, userId] of sessions)
        if (
          socket.readyState === WebSocket.OPEN &&
          event.recipients?.includes(userId)
        )
          socket.send(
            JSON.stringify({ type: "chat:update", chatId: event.chatId }),
          );
    } catch (e) {
      console.error("Invalid realtime event", e);
    }
  });
}
server.on("upgrade", async (req, socket, head) => {
  try {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || new URL(origin).host !== host) {
      socket.destroy();
      return;
    }
    if (!secret || secret.length < 32) {
      socket.destroy();
      return;
    }
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("pingme_session="))
      ?.slice("pingme_session=".length);
    if (!cookie) {
      socket.destroy();
      return;
    }
    const { payload } = await jwtVerify(
      decodeURIComponent(cookie),
      new TextEncoder().encode(secret),
    );
    if (typeof payload.sub !== "string") {
      socket.destroy();
      return;
    }
    const userId = payload.sub;
    await connectDb();
    const version = typeof payload.ver === "number" ? payload.ver : 0;
    const filter =
      version === 0
        ? {
            $or: [
              { sessionVersion: 0 },
              { sessionVersion: { $exists: false } },
            ],
          }
        : { sessionVersion: version };
    if (!(await User.exists({ _id: userId, ...filter }))) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.set(ws, userId);
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});
wss.on("connection", (ws) => {
  sendStatus(ws);
  ws.on("message", () => {
    /* read-only socket: persist messages via authorized HTTPS API */
  });
  ws.on("close", () => sessions.delete(ws));
  ws.on("error", () => sessions.delete(ws));
});
// An application heartbeat lets browsers detect a stalled socket or broker.
const heartbeat = setInterval(broadcastStatus, 20000);
heartbeat.unref();
server.on("close", () => {
  clearInterval(heartbeat);
  subscriber?.disconnect();
  wss.close();
});
export default server;
