# Ping Me Messenger — Next.js migration

This project consolidates the uploaded React/Vite UI and Express/Mongoose API into one Next.js App Router application. It preserves the original `User`, `Chat` and `Message` MongoDB collection/model names and major chat flows. The UI is a redesigned replacement, not a line-by-line copy. Pusher has been removed.

## Run locally

1. Install Node.js 20.9+ and run `npm install`.
2. Copy `.env.example` to `.env.local`, set `MONGODB_URI` and a random `JWT_SECRET` (32+ characters).
3. Run `npm run dev` and visit `http://localhost:3000`.
4. Run `npm run typecheck` and `npm run build` before deploying.

## Existing data compatibility

Existing MongoDB users retain bcrypt hashes; Mongoose defaults to the original collection names (`users`, `chats`, `messages`). User login continues with the original password hashes. New auth uses a secure HttpOnly session cookie. Existing image URLs remain intact, although images from the old Express server's local `/images/` path must be moved to stable object storage and their DB URLs updated to preserve avatars. No automatic migration is performed. Back up MongoDB before deployment.

## Real-time architecture

`api/ws.ts` exports an authenticated Node HTTP/WebSocket server using `ws`. A WebSocket-capable host must mount it at `/api/ws`; adding the file alone does not register a Next.js App Router endpoint. Clients receive chat IDs, then fetch the authorized data for affected conversations.

Configure a persistent Redis-compatible `REDIS_URL` with Pub/Sub support for delivery between API and WebSocket instances. Message creation, new direct/group chats, and group renames publish notifications to the participants. The server confirms subscription readiness using `sync:status` and sends a status heartbeat every 20 seconds. Clients only mark the connection live after this confirmation; an open socket without a working subscription keeps the fallback enabled.

While live, there is no periodic API polling. Socket events are batched for 150 ms, repeated reads share one in-flight request, and only the selected conversation is refreshed when its own ID changes. Sends and chat mutations update the initiating screen from their API responses without an immediate follow-up GET. The socket stays connected when switching chats.

If live delivery is unavailable, visible, online tabs refresh every 15 seconds. Hidden/offline tabs pause synchronization and close their sockets, then reconcile on return. Reconnects use exponential backoff up to 30 seconds; a missing heartbeat for 45 seconds restores the fallback. Local `next dev` does not mount the WebSocket server, so local development uses this fallback unless a WebSocket server is mounted separately.

Run `npm test` for synchronization, profile, image and QR regression tests and `npm run typecheck` for TypeScript validation. In process-restricted environments, `node tests/chat-sync.test.cjs` and `node tests/profile.test.cjs` run the same tests without spawning the test runner's child process.

## Profiles and contacts

Click your profile card to edit your name, email and bio, upload or remove your photo, change your password, or share your contact. Email changes require your current password. Password changes verify the current password, rotate the session cookie and invalidate earlier API sessions; the WebSocket server also checks the session version and closes existing user sockets through Redis notifications.

Avatars are compressed in the browser to WebP with a maximum 512-pixel edge. Small JPEG/PNG inputs still convert to WebP. The server validates and re-encodes the image, stores the binary in MongoDB's `profileimages` collection (one image per user), and serves it from `/api/users/[userId]/avatar`. There is no filesystem upload directory or extra storage account to configure. Browser inputs are limited to 12 MB; the API caps encoded uploads at 1 MB and saved images at 256 KB.

The Share contact tab generates a QR code locally and offers copy/share link and QR download controls. Contact URLs use `/?connect=<userId>`; they survive login and show a contact preview before starting a chat. The QR button beside people search can scan the rear camera, decode an uploaded QR image, or accept a pasted link. Camera access requires HTTPS or localhost; scanning and QR generation happen on-device, without an external QR service. For another device to connect, use the published app URL rather than localhost.

For an optional browser smoke check, run `node tests/browser-profile-smoke.cjs` with Chrome installed and the app running. It defaults to `http://localhost:3001`; override `PINGME_QA_URL` or `PINGME_QA_CHROME` as needed. It uses mocked API responses, simulated camera input and a temporary browser profile, so real accounts and chats are untouched.

## Scope and limitations

- Implemented: secure registration/login/logout; editable profiles and compressed WebP avatars; password changes; contact QR/link sharing and scanning; user search; direct chats; group creation and rename by admin; chat lists; message histories and sending; Redis-backed WebSocket change notifications; reconnection; HTTPS sync fallback; responsive visual refresh; installable web-app manifest and static-assets-only service worker.
- Not implemented: attachment upload, push notifications when the app is closed, read receipts, typing indicators, offline message caching, production rate limits and end-to-end browser tests.
- The WebSocket transport is native `ws`, not Socket.IO; there are **no Pusher dependencies**.
- Existing frontend and backend code is preserved in the provided source ZIPs, not embedded as duplicate unused modules in this project.
- Redis and MongoDB are separate managed services; free allowances depend on provider and usage.
- Security follow-up: production CSRF protection on state-changing cookie-based endpoints, anti-brute-force limits, audit logging, and Redis TLS configuration should be added before public launch. SameSite=Lax reduces but does not replace comprehensive CSRF defenses.

## Deployment

Import the repository into Vercel, set `MONGODB_URI`, `JWT_SECRET`, and optionally `REDIS_URL`. Use a MongoDB connection string with network access appropriately restricted for serverless connectivity. MongoDB Atlas and Redis may need their own accounts. Verify `/api/ws` can upgrade, client cookies authenticate, and a message sent in one client updates another client connected to a different Function instance.

## PWA installation and offline behavior

The in-app brand, favicon and install icons use the shared `/icon.svg` chat logo. The manifest includes 192px/512px PNG icons, an Android maskable icon, and a separate 180px Apple touch icon is declared in the document head. Icon URLs are versioned for updates. The manifest link is explicit in the head so browsers detect it before streamed metadata.

Deploy over HTTPS (localhost is allowed for development). The install control uses the browser prompt when available and provides manual installation instructions otherwise. Install availability and icon refresh timing depend on the browser; an existing installation may need reinstalling once if an old icon remains.

After an online visit activates the service worker, an offline launch shows a cached public reconnect page with the same logo. Chat, account changes and QR contact lookups require connectivity. API responses, private chat HTML and Next.js development scripts are never cached by the worker. Going online and tapping Try again reloads the original URL.

`node tests/pwa.test.cjs` verifies icon sizes, source consistency, Android safe-zone placement and favicon contents. The optional browser smoke check also verifies Chrome installability, icon links, service-worker registration, offline launch and reconnect. Browser account API writes are mocked; actual OS installation and physical-device behavior still require a device check.

## Message sounds

The app uses `public/audio/alert.mp3` for newly received messages and `public/audio/sentmessage.mp3` after a successful send. Initial history, own-message echoes, repeated synchronization responses, profile/group metadata changes and failed sends are silent. Incoming detection uses chat summaries, so it covers conversations that are not currently open, and batches a snapshot into one alert.

Audio elements are silently prepared on a pointer or keyboard gesture to support browser playback policies. Blocked or unavailable audio never interrupts messaging. Sound follows the existing synchronization lifecycle; background/closed-app push notifications are not implemented. Audio resources are released on logout.

Run `node tests/message-sounds.test.cjs` for message deduplication and playback lifecycle checks. The optional browser smoke check verifies real MP3 playback using mocked chat APIs and muted browser speaker output.
