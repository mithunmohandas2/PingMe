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

The browser opens one authenticated server-sent event connection at `/api/events`. The Next.js route works with ordinary `npm run dev` and `npm start`; no separate WebSocket server is needed. A process-shared event hub delivers chat changes immediately to participating users. Clients receive chat IDs, then fetch authorized chat summaries and the selected conversation only when that conversation changes. Message sends, edits, deletions, image sends, profile changes and group changes already publish these events.

For one Node process, including local development, Redis is optional and live delivery works without it. For multiple workers, replicas or serverless instances, configure a persistent Redis-compatible `PING_ME_REDIS_URL` with Pub/Sub support on every instance. Redis distributes events between instances; local delivery and event-ID deduplication prevent duplicate notifications. Do not rely on the in-memory hub for delivery across multiple instances.

While delivery is live, there is no periodic chat/history API polling. The stream carries a small status heartbeat every 20 seconds over the existing connection. Events are batched for 150 ms, concurrent reads share one request, and only the open conversation is refreshed for its own updates. Sending clients update their screens from mutation responses. Password changes push session revocation to existing streams.

Visible, online tabs use a 15-second fallback only while live delivery is unavailable. Hidden/offline tabs pause synchronization and close the stream, then reconcile on return. The existing controller owns exponential reconnect backoff and a 45-second heartbeat timeout. Streams rotate after four minutes to fit bounded hosting durations; reconnect performs one catch-up refresh. A pending `/api/events` request is expected. It is the open push stream, rather than repeated API requests.

The previous `api/ws.ts` standalone server is retained for legacy deployments but is no longer the browser's default transport. Pusher and Socket.IO are not required.

Run `npm test` and `npm run typecheck` for synchronization, stream authorization/recipient isolation and existing regression coverage. `tests/realtime-stream.test.cjs` verifies live local delivery, stream cleanup, heartbeat frames, session revocation and the browser transport adapter without writing to the database.

## Profiles and contacts

Click your profile card to edit your name, email and bio, upload or remove your photo, change your password, or share your contact. Email changes require your current password. Password changes verify the current password, rotate the session cookie and invalidate earlier API sessions; authenticated event streams receive a session-revocation event through the local hub and optional Redis fan-out.

Avatars are compressed in the browser to WebP with a maximum 512-pixel edge. Small JPEG/PNG inputs still convert to WebP. The server validates and re-encodes the image, stores the binary in MongoDB's `profileimages` collection (one image per user), and serves it from `/api/users/[userId]/avatar`. There is no filesystem upload directory or extra storage account to configure. Browser inputs are limited to 12 MB; the API caps encoded uploads at 1 MB and saved images at 256 KB.

The Share contact tab generates a QR code locally and offers copy/share link and QR download controls. Contact URLs use `/?connect=<userId>`; they survive login and show a contact preview before starting a chat. The QR button beside people search can scan the rear camera, decode an uploaded QR image, or accept a pasted link. Camera access requires HTTPS or localhost; scanning and QR generation happen on-device, without an external QR service. For another device to connect, use the published app URL rather than localhost.

For an optional browser smoke check, run `node tests/browser-profile-smoke.cjs` with Chrome installed and the app running. It defaults to `http://localhost:3001`; override `PINGME_QA_URL` or `PINGME_QA_CHROME` as needed. It uses mocked API responses, simulated camera input and a temporary browser profile, so real accounts and chats are untouched.

## Scope and limitations

- Implemented: secure registration/login/logout; editable profiles and compressed WebP avatars; password changes; contact QR/link sharing and scanning; user search; direct chats; group creation and rename by admin; chat lists; message histories, editing and bulk deletion; cropped, expiring WebP image messages; authenticated server-sent event notifications with optional Redis fan-out; reconnection; HTTPS sync fallback; responsive visual refresh; installable web-app manifest and static-assets-only service worker.
- Not implemented: non-image attachments, push notifications when the app is closed, read receipts, typing indicators, offline message caching, production rate limits and end-to-end browser tests.
- The browser uses native `EventSource` push delivery; there are **no Pusher or Socket.IO dependencies**.
- Existing frontend and backend code is preserved in the provided source ZIPs, not embedded as duplicate unused modules in this project.
- Redis and MongoDB are separate managed services; free allowances depend on provider and usage.
- Security follow-up: production CSRF protection on state-changing cookie-based endpoints, anti-brute-force limits, audit logging, and Redis TLS configuration should be added before public launch. SameSite=Lax reduces but does not replace comprehensive CSRF defenses.

## Deployment

Deploy the Next.js app with streaming response support and set `MONGODB_URI` and `JWT_SECRET`. Configure `PING_ME_REDIS_URL` for any deployment with multiple workers or serverless instances. Use a MongoDB connection string with appropriate network access. Ensure the host/proxy streams `/api/events` without buffering and permits a duration of at least 240 seconds, or lower the route lifetime to suit its limit. Verify authenticated streams become live and messages reach recipients on different instances.

## PWA installation and offline behavior

The in-app brand, favicon and install icons use the shared `/icon.svg` chat logo. The manifest includes 192px/512px PNG icons, an Android maskable icon, and a separate 180px Apple touch icon is declared in the document head. Icon URLs are versioned for updates. The manifest link is explicit in the head so browsers detect it before streamed metadata.

Deploy over HTTPS (localhost is allowed for development). The install control uses the browser prompt when available and provides manual installation instructions otherwise. Install availability and icon refresh timing depend on the browser; an existing installation may need reinstalling once if an old icon remains.

After an online visit activates the service worker, an offline launch shows a cached public reconnect page with the same logo. Chat, account changes and QR contact lookups require connectivity. API responses, private chat HTML and Next.js development scripts are never cached by the worker. Going online and tapping Try again reloads the original URL.

`node tests/pwa.test.cjs` verifies icon sizes, source consistency, Android safe-zone placement and favicon contents. The optional browser smoke check also verifies Chrome installability, icon links, service-worker registration, offline launch and reconnect. Browser account API writes are mocked; actual OS installation and physical-device behavior still require a device check.

## Message sounds

The app uses `public/audio/alert.mp3` for newly received messages and `public/audio/sentmessage.mp3` after a successful send. Initial history, own-message echoes, repeated synchronization responses, profile/group metadata changes and failed sends are silent. Incoming detection uses chat summaries, so it covers conversations that are not currently open, and batches a snapshot into one alert.

Audio elements are silently prepared on a pointer or keyboard gesture to support browser playback policies. Blocked or unavailable audio never interrupts messaging. Sound follows the existing synchronization lifecycle; background/closed-app push notifications are not implemented. Audio resources are released on logout.

Run `node tests/message-sounds.test.cjs` for message deduplication and playback lifecycle checks. The optional browser smoke check verifies real MP3 playback using mocked chat APIs and muted browser speaker output.

## Expiring chat images

Use the image button beside the message composer to choose a JPEG, PNG or WebP image (up to 12 MB), optionally adjust a free rectangular crop, and send a compressed WebP. Send without crop preserves the full image and its original proportions. The crop box can be dragged and resized directly at any aspect ratio. Both options use a maximum 1024-pixel edge. The server validates the real image, re-encodes it with Sharp, and limits the upload and saved bytes to 1 MB. Images can be previewed fullscreen and manually deleted through message selection; text editing is unavailable for image messages.

Image bytes are stored separately in MongoDB `chatimages`; message records retain only image metadata. Expiry is fixed to one hour after the server-created sent timestamp. One shared client clock updates tile countdowns every second without API polling, removes the displayed image, closes its preview and shows italic "Image auto deleted" at expiry. The chat-list preview updates too.

Only authenticated chat members can retrieve image bytes. Responses use `private, no-store`, and expired or manually deleted images return HTTP 410. An `expiresAt` TTL index automatically removes the stored binary even with no clients open. MongoDB TTL cleanup runs in the background and can lag behind expiry; access is blocked at the deadline regardless of cleanup timing. An expired-image request also removes any remaining bytes immediately. See [MongoDB TTL timing](https://www.mongodb.com/docs/manual/core/index-ttl/#timing-of-the-delete-operation). No application timer, cron service or filesystem upload folder is required.

`node tests/chat-images.test.cjs` covers conversion, size limits, expiry boundaries, authorization, cleanup and the TTL schema. The browser smoke check covers cropping, multipart upload, countdown updates, preview closure and the expired placeholder with mocked API responses.

## Deleted-message retention

Manual deletion immediately removes the original text or image bytes and keeps the italic deleted-message placeholder for 24 hours from `deletedAt`. The `messages` collection has a TTL index on `deletedAt` with `expireAfterSeconds: 86400`, which also applies to older existing deletion records. Automatically expired image placeholders are retained for 24 hours after `imageExpiresAt` (25 hours from the original send). A second message TTL index handles that policy; normal text messages with no deletion dates do not expire.

Database connections ensure both retention indexes exist, including after development hot reload. MongoDB removes eligible records through its background TTL process, so physical deletion can follow the exact cutoff shortly afterward. API history queries hide records past the cutoff, and open conversations hide expired placeholders without leaving blank rows. Chat-list reads resolve missing latest-message references to the most recent retained message in one batched query. No recurring application cleanup job or per-message API polling is needed.

`node tests/message-retention.test.cjs` checks boundary times, active-message safety, index configuration, retries and chat preview recovery. The browser smoke check advances time to verify old text and image placeholders disappear from an open conversation.

The Redis connection is configured only through the Vercel integration variable `PING_ME_REDIS_URL`. Use the provider-issued TCP/TLS connection string and redeploy after changing Vercel environment values; never expose it through a `NEXT_PUBLIC_` variable.

## Account deletion

The fourth profile sidebar tab is Delete account. It explains the consequences, requires the current password and an acknowledgment checkbox, then opens a separate final confirmation. Cancel does not send a deletion request. Only the authenticated owner can delete an account; the API rejects missing/incorrect passwords and cross-origin requests.

Deletion runs in a MongoDB transaction (MongoDB Atlas supports this). It anonymizes the user immediately, clears profile details and the saved avatar, invalidates existing sessions, and removes the account from shared groups. An active group member becomes administrator when necessary. Other participants receive a chat-change event. Direct conversations become read-only in both the UI and send APIs: the composer shows User account deleted, disables text/image sending, and warns about the scheduled history-removal date.

Direct chats, every message in those direct chats (including the other participant's messages), the deleted account's messages in shared groups, and the anonymized user record receive an accountPurgeAt deadline 15 days after deletion. TTL indexes on users, chats and messages remove these records automatically. Shared-group messages belonging to other members remain. Existing shorter retention rules still apply to manually deleted messages and expired images. Cleanup runs through MongoDB TTL and can follow the precise deadline shortly afterward; history APIs and open message rows enforce the cutoff immediately. No Vercel cron job is required.

The API guards against concurrent text/image sends or avatar updates restoring data after deletion. The account-deletion tests cover authorization, password/confirmation requirements, transaction rollback, anonymization, history scope and revoked sessions. Browser tests exercise both confirmation steps, cancellation, sign-out and the deleted-participant composer using mocked API writes.

## Chat controls and privacy

The More dropdown is used on desktop and mobile. In an open chat it offers Clear chat (or Clear group chat), Block/Unblock user for direct conversations, and Leave group for group conversations. Clear, block/unblock and exit actions show a confirmation first. Group administrators can also rename the group from the menu.

Clearing stores a private per-user cutoff in `chatpreferences`. History, image retrieval and chat previews respect that cutoff; shared message records and other participants' copies are untouched. New messages after clearing still appear. The client filters stale in-flight history responses so clearing cannot briefly restore old rows, and clearing one login does not affect another user's view.

Blocking is persisted in `userblocks` and reflected on direct-chat records. Direct text/image sends, message edits and starting a new direct chat are rejected by the server while either participant has a block. Existing history and shared groups remain available. Only the user who added a block can remove it; if both users block one another, both blocks must be removed to resume messaging.

Leaving a group removes membership and all further history/image access. Another member becomes administrator if the admin leaves. Remaining members keep their shared messages. If the final member leaves, the abandoned group and its history are scheduled for cleanup after 15 days. Account deletion also removes that user's private chat preferences and block records.

`tests/chat-actions.test.cjs` covers private clears, ownership, membership removal, admin transfer, last-member cleanup, blocking and unblock ownership. Browser tests verify the desktop dropdown and action/cancel flows without changing real conversations.

The sidebar Search recent chats field filters the loaded conversation list locally by contact name/email or group name, ignoring case and surrounding whitespace. It does not query the user directory or create conversations. Use the QR button to scan/upload a contact code or open a contact link to start a new direct chat. Group-member selection retains its separate search inside the group creation dialog.

When a group has exactly one remaining member, More options also shows Delete group. Its confirmation explicitly warns that deletion is permanent. The server checks membership again inside a transaction and deletes the group, all of its messages, matching image bytes and every participant's saved chat preferences. This removes history immediately rather than waiting for the abandoned-group retention period. Other conversations are unaffected. A concurrent membership change aborts deletion before history is removed.

Renaming a group automatically creates a message attributed to the authenticated group admin: "Changed the group name from OLD to NEW". The rename and activity message are committed in the same transaction, become the latest chat preview, and notify group members through the existing push stream. The conversation and preview render activity text in italics. Unchanged names do not create duplicate messages; automatic activity text cannot be edited or individually deleted. Rename activity is non-selectable and uses the muted italic deleted-message appearance without sender/time metadata; both single and bulk deletion APIs protect it.
