// Optional local browser smoke check. API responses are intercepted: no accounts
// or conversations are written to the configured database.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const sharp = require("sharp");
const QRCode = require("qrcode");
const base = process.env.PINGME_QA_URL || "http://localhost:3001";
const chrome =
  process.env.PINGME_QA_CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pingme-browser-"));
  const photo = path.join(profile, "profile.jpg"),
    qrFile = path.join(profile, "contact.png");
  await sharp({
    create: { width: 900, height: 1400, channels: 3, background: "#2563eb" },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="900" height="700"><rect width="900" height="700" fill="red"/></svg>',
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toFile(photo);
  const user = {
    _id: "507f1f77bcf86cd799439011",
    name: "Browser Test",
    email: "browser@example.invalid",
    image: "",
    bio: "",
  };
  const target = {
    _id: "507f1f77bcf86cd799439012",
    name: "QR Contact",
    email: "contact@example.invalid",
    bio: "Scanned contact",
    image: "",
  };
  await QRCode.toFile(qrFile, base + "/?connect=" + target._id, {
    width: 400,
    margin: 4,
  });
  const avatar =
    "data:image/webp;base64," +
    (
      await sharp({
        create: { width: 80, height: 80, channels: 3, background: "blue" },
      })
        .webp()
        .toBuffer()
    ).toString("base64");
  target.image = avatar;
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--mute-audio",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "about:blank",
    ],
    { windowsHide: true },
  );
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Chrome did not start")),
        10000,
      );
      browser.on("error", reject);
      browser.stderr.on("data", (chunk) => {
        const match = String(chunk).match(
          /DevTools listening on (ws:\/\/[^\s]+)/,
        );
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    let sequence = 0,
      session;
    const pending = new Map(),
      exceptions = [],
      requests = [];
    let authenticated = true;
    let latestChat = null,
      failNextSend = false;
    let failNextLogout = false;
    const chatMessages = [];
    let imageSequence = 0;
    function send(method, params = {}, sessionId = session) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("CDP timeout: " + method));
        }, 15000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    }
    ws.on("message", async (raw) => {
      const event = JSON.parse(raw);
      if (event.id) {
        const item = pending.get(event.id);
        if (item) {
          pending.delete(event.id);
          event.error
            ? item.reject(new Error(event.error.message))
            : item.resolve(event.result);
        }
        return;
      }
      if (event.method === "Runtime.exceptionThrown")
        exceptions.push(
          event.params.exceptionDetails.exception?.description ||
            event.params.exceptionDetails.text,
        );
      if (event.method !== "Fetch.requestPaused") return;
      const { requestId, request } = event.params;
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        method: request.method,
        contentType:
          request.headers["Content-Type"] || request.headers["content-type"],
      });
      let data = null;
      if (url.pathname === "/api/auth/me") data = authenticated ? user : null;
      else if (url.pathname === "/api/auth/logout") {
        if (failNextLogout) failNextLogout = false;
        else {
          authenticated = false;
          data = { message: "Signed out" };
        }
      } else if (url.pathname === "/api/auth/login") {
        authenticated = true;
        data = user;
      } else if (url.pathname === "/api/chats" && request.method === "GET")
        data = latestChat ? [latestChat] : [];
      else if (
        url.pathname === "/api/chats/rename" &&
        request.method === "PUT"
      ) {
        const { chatName } = JSON.parse(request.postData),
          name = chatName.trim(),
          previous = latestChat.chatName;
        if (name !== previous) {
          const message = {
            _id: "507f1f77bcf86cd799439050",
            chat: latestChat._id,
            sender: user,
            kind: "group-rename",
            content: "Changed the group name from " + previous + " to " + name,
            createdAt: new Date().toISOString(),
          };
          chatMessages.push(message);
          latestChat.chatName = name;
          latestChat.latestMessage = message;
          latestChat.updatedAt = message.createdAt;
          data = { ...latestChat, activityMessage: message };
        } else data = { ...latestChat };
      } else if (
        url.pathname.startsWith("/api/chats/") &&
        url.pathname.endsWith("/actions") &&
        request.method === "POST"
      ) {
        const { action } = JSON.parse(request.postData);
        if (action === "clear") {
          latestChat.clearedAt = new Date().toISOString();
          latestChat.latestMessage = null;
          data = { action, clearedAt: latestChat.clearedAt };
        } else if (action === "delete-group") {
          assert.equal(latestChat.users.length, 1);
          assert.equal(latestChat.users[0]._id, user._id);
          const deletedId = latestChat._id;
          for (let index = chatMessages.length - 1; index >= 0; index--)
            if (chatMessages[index].chat === deletedId)
              chatMessages.splice(index, 1);
          latestChat = null;
          data = { action };
        } else if (action === "leave") {
          latestChat.users = latestChat.users.filter(
            (member) => member._id !== user._id,
          );
          latestChat.groupAdmin = latestChat.users[0];
          latestChat = null;
          data = { action };
        } else {
          latestChat.blockedByMe = action === "block";
          latestChat.messagingBlocked = action === "block";
          data = {
            action,
            blockedByMe: latestChat.blockedByMe,
            messagingBlocked: latestChat.messagingBlocked,
          };
        }
      } else if (
        url.pathname === "/api/profile/account" &&
        request.method === "DELETE"
      ) {
        const values = JSON.parse(request.postData);
        assert.equal(values.confirmation, "DELETE");
        assert.ok(values.currentPassword);
        authenticated = false;
        data = {
          message: "Your account has been deleted.",
          accountPurgeAt: new Date(Date.now() + 15 * 86400000).toISOString(),
        };
      } else if (url.pathname === "/api/profile/avatar") {
        user.image = request.method === "DELETE" ? "" : avatar;
        data = user;
      } else if (
        url.pathname === "/api/profile" &&
        request.method === "PATCH"
      ) {
        const values = JSON.parse(request.postData);
        Object.assign(user, {
          name: values.name,
          email: values.email,
          bio: values.bio,
        });
        data = user;
      } else if (url.pathname === "/api/profile/password")
        data = {
          message: "Password changed. Other sessions have been signed out.",
        };
      else if (url.pathname === "/api/users/" + target._id) data = target;
      else if (url.pathname === "/api/chats" && request.method === "POST") {
        data = {
          _id: "507f1f77bcf86cd799439013",
          isGroup: false,
          users: [user, target],
          updatedAt: new Date().toISOString(),
        };
        latestChat = data;
      } else if (
        url.pathname === "/api/messages" &&
        request.method === "POST"
      ) {
        if (failNextSend) {
          failNextSend = false;
        } else {
          const values = JSON.parse(request.postData);
          data = {
            _id: "507f1f77bcf86cd799439021",
            sender: user,
            content: values.content,
            createdAt: new Date().toISOString(),
          };
          chatMessages.push(data);
          latestChat.latestMessage = data;
          latestChat.updatedAt = data.createdAt;
        }
      } else if (
        url.pathname === "/api/messages/image" &&
        request.method === "POST"
      ) {
        data = {
          _id: (
            BigInt("0x507f1f77bcf86cd799439024") + BigInt(imageSequence++)
          ).toString(16),
          sender: user,
          kind: "image",
          content: "Image",
          createdAt: new Date().toISOString(),
          imageExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        chatMessages.push(data);
        latestChat.latestMessage = data;
        latestChat.updatedAt = data.createdAt;
      } else if (
        url.pathname.startsWith("/api/messages/image/") &&
        request.method === "GET"
      ) {
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "image/webp" },
            { name: "Cache-Control", value: "no-store" },
          ],
          body: avatar.split(",")[1],
        });
        return;
      } else if (
        url.pathname.startsWith("/api/messages/") &&
        url.pathname.split("/").length === 4 &&
        request.method === "DELETE"
      ) {
        const ids = JSON.parse(request.postData).messageIds;
        const targets = chatMessages.filter(
          (item) =>
            ids.includes(item._id) &&
            item.sender._id === user._id &&
            !item.deletedAt,
        );
        if (targets.length === ids.length) {
          for (const message of targets)
            Object.assign(message, {
              content: "Message has been deleted",
              deletedAt: new Date().toISOString(),
              editedAt: null,
            });
          data = targets;
        }
      } else if (
        url.pathname.startsWith("/api/messages/") &&
        ["PATCH", "DELETE"].includes(request.method)
      ) {
        const message = chatMessages.find(
          (item) => item._id === url.pathname.split("/").pop(),
        );
        if (message && message.sender._id === user._id && !message.deletedAt) {
          if (request.method === "DELETE")
            Object.assign(message, {
              content: "Message has been deleted",
              deletedAt: new Date().toISOString(),
              editedAt: null,
            });
          else
            Object.assign(message, {
              content: JSON.parse(request.postData).content,
              editedAt: new Date().toISOString(),
            });
          data = message;
        }
      } else if (url.pathname.startsWith("/api/messages/"))
        data = chatMessages.filter(
          (message) =>
            !latestChat?.clearedAt ||
            Date.parse(message.createdAt) > Date.parse(latestChat.clearedAt),
        );
      try {
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: data === null ? 404 : 200,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
          ],
          body: Buffer.from(
            JSON.stringify(data === null ? { message: "Not found" } : { data }),
          ).toString("base64"),
        });
      } catch (error) {
        // Navigation can cancel an intercepted request before CDP fulfills it.
        if (error.message !== "Invalid InterceptionId.")
          exceptions.push(error.message);
      }
    });
    const targetPage = await send("Target.createTarget", {
      url: "about:blank",
    });
    session = (
      await send("Target.attachToTarget", {
        targetId: targetPage.targetId,
        flatten: true,
      })
    ).sessionId;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      // Exercise account controls mounting after Messenger's first lookup.
      const nativeGetElementById = Document.prototype.getElementById;
      let delayAccountTarget = true;
      Document.prototype.getElementById = function(id) {
        if (id === "mobile-account-actions" && delayAccountTarget) {
          delayAccountTarget = false;
          return null;
        }
        return nativeGetElementById.call(this, id);
      };
      window.qaChatImageUploads = [];
      const nativeFetch = window.fetch;
      window.fetch = async function(input, options) {
        if (typeof input === "string" && input === "/api/messages/image" && options?.body instanceof FormData) {
          const file = options.body.get("image"), bitmap = await createImageBitmap(file);
          window.qaChatImageUploads.push({type:file.type,width:bitmap.width,height:bitmap.height,size:file.size});
          bitmap.close();
        }
        return nativeFetch.call(this,input,options);
      };
      window.qaPlayedSounds = [];
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) {
        const source = this.src || "";
        const audible = !this.muted && source.includes("/audio/");
        const result = nativePlay.apply(this, args);
        return Promise.resolve(result).then(() => { if (audible) window.qaPlayedSounds.push(new URL(source).pathname); });
      };
    `,
    });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await send("Fetch.enable", {
      patterns: [{ urlPattern: base + "/api/*", requestStage: "Request" }],
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text,
        );
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(100);
      }
      throw new Error(
        "UI timeout: " +
          expression +
          "; browser errors: " +
          exceptions.join(" | "),
      );
    };
    const click = (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) =>
      evaluate(
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    const upload = async (selector, filename) => {
      const { root } = await send("DOM.getDocument");
      const { nodeId } = await send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      await send("DOM.setFileInputFiles", { nodeId, files: [filename] });
    };
    await send("Page.navigate", { url: base });
    await wait('!!document.querySelector(".myprofile")');
    const typography = await evaluate(`(async()=>{
      await document.fonts.ready;
      return {family:getComputedStyle(document.body).fontFamily,loaded:[...document.fonts].some(font=>font.family.includes('Poppins')&&font.status==='loaded')};
    })()`);
    assert.match(typography.family, /Poppins/);
    assert.equal(
      typography.loaded,
      true,
      "Poppins font files must load successfully",
    );
    await wait('!!document.querySelector(".mobile-account-actions button")');
    await click(".chat-more-button");
    assert.ok(
      await evaluate(
        'Array.from(document.querySelectorAll(".app-controls-actions button")).every(button=>button.getBoundingClientRect().width>=200 && button.getBoundingClientRect().height<=44)',
      ),
      "Dropdown rows including install must use the full width and stay on one line",
    );
    assert.ok(
      await evaluate(
        `document.querySelector('[aria-label="Open your account"]').getClientRects().length > 0`,
      ),
      "Account button must be visible in the messages screen dropdown even if shared controls mount later",
    );
    await click(".chat-more-button");

    const header = await evaluate(
      `(()=>{const brand=document.querySelector('.sidehead .brand').getBoundingClientRect(),controls=document.querySelector('.app-controls').getBoundingClientRect();return {aligned:Math.abs((brand.top+brand.height/2)-(controls.top+controls.height/2))<5,overflows:document.documentElement.scrollWidth>innerWidth}})()`,
    );
    assert.equal(header.aligned, true);
    assert.equal(header.overflows, false);
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".myprofile")).display',
      ),
      "none",
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".app-controls-actions button").length',
      ),
      4,
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 740,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await delay(100);
    assert.equal(
      await evaluate(
        '(()=>{const brand=document.querySelector(".sidehead .brand").getBoundingClientRect(), controls=document.querySelector(".app-controls").getBoundingClientRect();return brand.right <= controls.left && document.documentElement.scrollWidth <= innerWidth})()',
      ),
      true,
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await click(".chat-more-button");
    await click('[aria-label="Open your account"]');
    await wait('!!document.querySelector(".profile-editor")');
    for (const width of [320, 390, 768, 1280]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 800,
      });
      await delay(100);
      const layout = await evaluate(`(()=>{
        const modal=document.querySelector('.profile-editor'),rect=modal.getBoundingClientRect(),fields=document.querySelector('.profile-fields');
        const controls=document.querySelector('.app-controls').getBoundingClientRect();
        return {width:rect.width,withinViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,
          verticalTabs:document.querySelectorAll(".profile-tabs button")[1].getBoundingClientRect().top>document.querySelectorAll(".profile-tabs button")[0].getBoundingClientRect().bottom,overflow:modal.scrollWidth>modal.clientWidth,twoColumns:Math.abs(fields.children[0].getBoundingClientRect().top-fields.children[1].getBoundingClientRect().top)<1,
          hiddenInput:getComputedStyle(document.querySelector('input[aria-label="Choose profile photo"]')).display==='none',
          controlsCovered:!document.elementFromPoint(controls.left+10,controls.top+10)?.closest('.app-controls')};
      })()`);
      assert.equal(
        layout.withinViewport,
        true,
        "Modal must fit viewport at " + width,
      );
      assert.equal(
        layout.overflow,
        false,
        "No horizontal overflow at " + width,
      );
      assert.equal(
        layout.verticalTabs,
        true,
        "Profile tabs must stack vertically at " + width,
      );
      assert.equal(layout.hiddenInput, true);
      assert.equal(layout.controlsCovered, true);
      assert.equal(
        layout.twoColumns,
        width > 600,
        "Form columns at " + width + ": " + JSON.stringify(layout),
      );
      if (width === 1280) assert.ok(layout.width >= 800);
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await fill(
      '.profile-fields input[autocomplete="name"]',
      "Updated Browser Name",
    );
    await click('.profile-fields button[type="submit"]');
    await wait(
      'document.querySelector(".notification-toast")?.textContent.includes("Profile updated")',
    );
    assert.equal(user.name, "Updated Browser Name");
    assert.ok(
      await evaluate(
        '!document.querySelector(".profile-content [role=status]")',
      ),
      "Success toast must not take space inside the profile form",
    );
    await wait('!document.querySelector(".notification-toast")');

    const uploadsBeforeCrop = requests.filter(
      (request) => request.path === "/api/profile/avatar",
    ).length;
    await upload('input[aria-label="Choose profile photo"]', photo);
    await wait('!!document.querySelector(".photo-crop-stage canvas")');
    await click(".photo-dialog-actions .secondary-action");
    assert.equal(
      requests.filter((request) => request.path === "/api/profile/avatar")
        .length,
      uploadsBeforeCrop,
      "Cancel must not upload a photo",
    );
    await upload('input[aria-label="Choose profile photo"]', photo);
    await wait('!document.querySelector(".photo-crop-controls").disabled');
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [1280, 720],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 800,
      });
      const fits = await evaluate(
        '(()=>{const d=document.querySelector(".photo-dialog"),r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1 && d.scrollWidth<=d.clientWidth+1})()',
      );
      assert.ok(fits, "Crop dialog must fit viewport at " + width);
    }
    await fill('input[aria-label="Photo zoom"]', "2");
    await fill('input[aria-label="Photo vertical position"]', "0");
    await delay(100);
    const topPixel = await evaluate(
      'Array.from(document.querySelector(".photo-crop-stage canvas").getContext("2d").getImageData(256,256,1,1).data)',
    );
    await fill('input[aria-label="Photo vertical position"]', "1");
    await delay(100);
    const bottomPixel = await evaluate(
      'Array.from(document.querySelector(".photo-crop-stage canvas").getContext("2d").getImageData(256,256,1,1).data)',
    );
    assert.ok(
      topPixel[0] > 200 && bottomPixel[2] > 150,
      "Crop position must change the exported canvas pixels",
    );
    const cropped = await evaluate(
      '(async()=>{const c=document.querySelector(".photo-crop-stage canvas");const b=await new Promise(resolve=>c.toBlob(resolve,"image/webp",0.8));return {width:c.width,height:c.height,type:b.type,size:b.size}})()',
    );
    assert.equal(cropped.width, 512);
    assert.equal(cropped.height, 512);
    assert.equal(cropped.type, "image/webp");
    assert.ok(cropped.size < 1024 * 1024);
    await click(".photo-dialog-actions .primary");
    await wait(
      'document.querySelector(".notification-toast")?.textContent.includes("photo updated")',
    );
    assert.ok(
      requests.some(
        (request) =>
          request.path === "/api/profile/avatar" &&
          request.contentType.includes("multipart/form-data"),
      ),
    );
    await click('button[aria-label="View your profile photo"]');
    await wait('document.querySelector(".photo-preview-image img")?.complete');
    assert.ok(
      await evaluate(
        `!!document.querySelector('.photo-dialog-header-actions button[aria-label="Fullscreen"]')`,
      ),
    );
    await click(
      '.photo-dialog-header-actions button[aria-label="Close photo"]',
    );
    assert.ok(
      await evaluate(
        '!!document.querySelector(".profile-editor") && !document.querySelector(".photo-dialog")',
      ),
      "Closing own photo preview must keep profile settings open",
    );
    const deletionsBefore = requests.filter(
      (request) =>
        request.path === "/api/profile/avatar" && request.method === "DELETE",
    ).length;
    await click(".photo-actions .text-action");
    await wait(
      'document.querySelector(".photo-dialog h3")?.textContent.includes("Remove profile photo")',
    );
    await click(".photo-dialog-actions .secondary-action");
    assert.equal(
      requests.filter(
        (request) =>
          request.path === "/api/profile/avatar" && request.method === "DELETE",
      ).length,
      deletionsBefore,
    );
    assert.ok(user.image, "Cancel must keep the profile photo");
    await click(".photo-actions .text-action");
    await click(".photo-dialog-actions .danger");
    await wait(
      'document.querySelector(".notification-toast")?.textContent.includes("photo removed")',
    );
    assert.equal(user.image, "");
    assert.equal(
      requests.filter(
        (request) =>
          request.path === "/api/profile/avatar" && request.method === "DELETE",
      ).length,
      deletionsBefore + 1,
    );
    await evaluate(
      'document.querySelectorAll(".profile-tabs button")[1].click()',
    );
    await fill('input[name="currentPassword"]', "Original-password");
    await fill('input[name="newPassword"]', "New-password-123");
    await fill('input[name="confirmPassword"]', "Does-not-match");
    await click('.profile-fields button[type="submit"]');
    await wait(
      'document.querySelector(".profile-editor .error")?.textContent.includes("do not match")',
    );
    await fill('input[name="confirmPassword"]', "New-password-123");
    await click('.profile-fields button[type="submit"]');
    await wait(
      'document.querySelector(".notification-toast")?.textContent.includes("Password changed")',
    );
    await evaluate(
      'document.querySelectorAll(".profile-tabs button")[2].click()',
    );
    await wait('document.querySelector(".contact-qr img")?.complete');
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [1280, 720],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 800,
      });
      const fit = await evaluate(
        '(()=>{const modal=document.querySelector(".profile-editor");return {vertical:modal.scrollHeight<=modal.clientHeight+1,horizontal:modal.scrollWidth<=modal.clientWidth+1}})()',
      );
      assert.ok(
        fit.vertical && fit.horizontal,
        "Share contact must fit without scrolling at " +
          width +
          ": " +
          JSON.stringify(fit),
      );
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });

    assert.equal(
      await evaluate(
        'document.querySelector(".contact-link-label input").value',
      ),
      base + "/?connect=" + user._id,
    );
    await click('[aria-label="Close profile"]');
    await click('[aria-label="Scan contact QR code"]');
    await wait('!!document.querySelector(".scanner-modal")');
    await evaluate(
      'document.querySelector(".scanner-modal .contact-share-actions button").click()',
    );
    await wait('!!document.querySelector(".scanner-camera video")?.srcObject');
    await evaluate(
      'window.qaTracks=document.querySelector(".scanner-camera video").srcObject.getTracks()',
    );
    await click('[aria-label="Close scanner"]');
    await wait('window.qaTracks.every(track=>track.readyState==="ended")');
    await click('[aria-label="Scan contact QR code"]');
    await upload('input[aria-label="Upload QR image"]', qrFile);
    await wait(
      'document.querySelector(".contact-preview-person h4")?.textContent==="QR Contact"',
    );
    await click(".contact-preview .primary");
    await wait(
      'document.querySelector(".conversationhead strong")?.textContent==="QR Contact"',
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const directoryRequestsBefore = requests.filter(
      (request) => request.path === "/api/users",
    ).length;
    await fill('input[aria-label="Search recent chats"]', "  qR cOn  ");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".scrolllist .chatentry").length',
      ),
      1,
      "Local search must ignore case and surrounding whitespace",
    );
    await fill('input[aria-label="Search recent chats"]', "unknown-contact");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".scrolllist .chatentry").length',
      ),
      0,
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".scrolllist").textContent.includes("No matching chats")',
      ),
    );
    await delay(400);
    assert.equal(
      requests.filter((request) => request.path === "/api/users").length,
      directoryRequestsBefore,
      "Recent-chat search must not query the user directory",
    );
    await click('[aria-label="Clear search"]');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".scrolllist .chatentry").length',
      ),
      1,
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    console.log(
      "Recent chat search checks passed: local case-insensitive filtering, empty state, clear reset, and no user-directory API calls.",
    );
    // Use a trusted pointer gesture so real browser autoplay policy is exercised.
    const clickTrusted = async (selector) => {
      const point = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    };
    assert.deepEqual(await evaluate("window.qaPlayedSounds"), []);
    await fill(".composer input:not([type=file])", "Sound test message");
    await clickTrusted(".sendbtn");
    await wait('window.qaPlayedSounds.includes("/audio/sentmessage.mp3")');
    assert.equal(
      await evaluate(
        'window.qaPlayedSounds.filter(path=>path==="/audio/sentmessage.mp3").length',
      ),
      1,
    );
    const incoming = {
      _id: "507f1f77bcf86cd799439022",
      sender: target,
      content: "Incoming sound test",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    };
    chatMessages.push(incoming);
    latestChat.latestMessage = incoming;
    latestChat.updatedAt = incoming.createdAt;
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait('window.qaPlayedSounds.includes("/audio/alert.mp3")');
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await delay(400);
    assert.equal(
      await evaluate(
        'window.qaPlayedSounds.filter(path=>path==="/audio/alert.mp3").length',
      ),
      1,
    );
    failNextSend = true;
    await fill(
      ".composer input:not([type=file])",
      "Failed send must stay silent",
    );
    await clickTrusted(".sendbtn");
    await wait(
      'document.querySelector(".toast")?.textContent.includes("Not found")',
    );
    assert.equal(
      await evaluate(
        'window.qaPlayedSounds.filter(path=>path==="/audio/sentmessage.mp3").length',
      ),
      1,
    );
    console.log(
      "Message sound browser checks passed: real MP3 playback on successful send and incoming message, no duplicate alerts, and no send sound on failure.",
    );
    const longPress = async (selector) => {
      const point = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await delay(600);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    };
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".message-actions button").length',
      ),
      0,
    );
    await clickTrusted(".msgrow.own .bubble");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-selection-actions button").length',
      ),
      0,
      "A single click must not start selection",
    );
    await longPress(".msgrow.theirs .bubble");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-selection-actions button").length',
      ),
      0,
      "Other users messages cannot be selected for editing or deletion",
    );
    // Exercise a real touch long press as well as mouse holds.
    const touchPoint = await evaluate(
      '(()=>{const r=document.querySelector(".msgrow.own .bubble").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touchPoint],
    });
    await delay(600);
    await send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await wait(
      `!!document.querySelector('[aria-label="Edit selected message"]')`,
    );
    const draftBeforeEdit = await evaluate(
      'document.querySelector(".composer input:not([type=file])").value',
    );
    await click('[aria-label="Edit selected message"]');
    assert.ok(
      await evaluate(
        '!!document.querySelector(".composer.is-editing") && !document.querySelector("dialog[open]")',
      ),
      "Editing must reuse the composer without a modal",
    );
    assert.ok(
      await evaluate(
        'document.activeElement.matches(".composer input:not([type=file])")',
      ),
      "Editing must focus the composer",
    );
    await fill(".composer input:not([type=file])", "Discard this edit");
    await click('[aria-label="Cancel editing"]');
    assert.equal(
      await evaluate(
        'document.querySelector(".composer input:not([type=file])").value',
      ),
      draftBeforeEdit,
      "Cancel must restore the unsent draft",
    );
    await longPress(".msgrow.own .bubble");
    await click('[aria-label="Edit selected message"]');
    await fill(".composer input:not([type=file])", "Edited message content");
    await click('[aria-label="Save message changes"]');
    await wait(
      'document.querySelector(".msgrow.own .bubble p")?.textContent==="Edited message content"',
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".msgrow.own .message-edited")?.textContent',
      ),
      "edited",
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".composer input:not([type=file])").value',
      ),
      draftBeforeEdit,
      "Saving must restore the unsent draft",
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-selection-actions button").length',
      ),
      0,
    );
    const secondOwn = {
      _id: "507f1f77bcf86cd799439023",
      sender: user,
      content: "Another owned message",
      createdAt: new Date().toISOString(),
    };
    chatMessages.push(secondOwn);
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait('document.querySelectorAll(".msgrow.own").length===2');
    await longPress(".msgrow.own .bubble");
    await clickTrusted('[data-message-id="507f1f77bcf86cd799439023"] .bubble');
    await wait(
      'document.querySelector(".conversation-identity strong")?.textContent==="2 selected"',
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[aria-label="Edit selected message"]').length`,
      ),
      0,
      "Multiple selection must hide edit",
    );
    await click('[aria-label="Delete selected messages"]');
    await click(".message-edit-form .secondary-action");
    assert.equal(
      await evaluate('document.querySelectorAll(".msgrow.own em").length'),
      0,
      "Cancel must keep both messages",
    );
    await click('[aria-label="Delete selected messages"]');
    await click(".message-edit-form .danger");
    await wait(
      'document.querySelectorAll(".msgrow.own .bubble em").length===2',
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-selection-actions button, .msgrow.own time, .msgrow.own .message-edited").length',
      ),
      0,
    );
    assert.equal(
      requests.filter(
        (request) =>
          request.path.startsWith("/api/messages/") &&
          request.method === "DELETE",
      ).length,
      1,
      "Bulk delete must use one request",
    );
    assert.equal(
      await evaluate(
        'window.qaPlayedSounds.filter(path=>path==="/audio/sentmessage.mp3").length',
      ),
      1,
      "Edit and delete must stay silent",
    );
    console.log(
      "Message selection checks passed: long press only, owner-only selection, header editing, tap multi-select, hidden edit and confirmed bulk delete.",
    );
    await upload('input[aria-label="Choose chat image"]', photo);
    await wait(
      '!!document.querySelector(".chat-crop-stage canvas") && !document.querySelector(".chat-crop-tools button").disabled',
    );
    const originalPreview = await evaluate(
      '(()=>{const c=document.querySelector(".chat-crop-stage canvas");return {width:c.width,height:c.height}})()',
    );
    assert.ok(
      Math.abs(originalPreview.width / originalPreview.height - 900 / 1400) <
        0.002,
      "Preview must preserve the original portrait ratio",
    );
    await click(".chat-crop-tools .secondary-action");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".photo-dialog input[type=range]").length',
      ),
      0,
      "Chat cropping must not show sliders",
    );
    const handle = await evaluate(
      '(()=>{const r=document.querySelector(".crop-handle.se").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...handle,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: handle.x + 12,
      y: handle.y - 12,
      button: "left",
      buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: handle.x + 12,
      y: handle.y - 12,
      button: "left",
      clickCount: 1,
    });
    const cropRatio = await evaluate(
      '(parseFloat(document.querySelector(".chat-crop-box").style.width)/parseFloat(document.querySelector(".chat-crop-box").style.height))*(900/1400)',
    );
    assert.ok(
      Math.abs(cropRatio - 900 / 1400) > 0.01,
      "Dragging the crop handle must resize the free crop",
    );
    await click(".chat-image-actions .primary");
    await wait('document.querySelector(".chat-image")?.complete');
    const imageMessage = chatMessages.find(
      (message) => message.kind === "image",
    );
    assert.equal(
      requests.filter(
        (request) =>
          request.path === "/api/messages/image" && request.method === "POST",
      ).length,
      1,
    );
    assert.ok(
      requests
        .find((request) => request.path === "/api/messages/image")
        .contentType.includes("multipart/form-data"),
    );
    const croppedUpload = await evaluate("window.qaChatImageUploads[0]");
    assert.equal(croppedUpload.type, "image/webp");
    assert.ok(
      Math.abs(croppedUpload.width / croppedUpload.height - cropRatio) < 0.005,
      "Exported crop must keep the chosen free aspect ratio",
    );
    await upload('input[aria-label="Choose chat image"]', photo);
    await wait(
      '!!document.querySelector(".chat-crop-stage canvas") && !document.querySelector(".chat-crop-tools button").disabled',
    );
    await click(".chat-image-actions .primary");
    await wait('document.querySelectorAll(".chat-image").length===2');
    const fullUpload = await evaluate("window.qaChatImageUploads[1]");
    assert.equal(fullUpload.type, "image/webp");
    assert.ok(
      Math.abs(fullUpload.width / fullUpload.height - 900 / 1400) < 0.002,
      "Send without crop must preserve the entire image ratio",
    );
    assert.ok(fullUpload.width <= 1024 && fullUpload.height <= 1024);

    const countdown = await evaluate(
      'document.querySelector(".image-countdown").textContent',
    );
    await wait(
      `!!document.querySelector(".image-countdown") && document.querySelector(".image-countdown").textContent !== ${JSON.stringify(countdown)}`,
    );
    await longPress(".image-message");
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[aria-label="Edit selected message"]').length`,
      ),
      0,
      "Image messages must not offer text editing",
    );
    await click('[aria-label="Cancel message selection"]');
    await clickTrusted(".image-message");
    await wait('!!document.querySelector(".photo-preview-image img")');
    await click(
      '.photo-dialog-header-actions button[aria-label="Close photo"]',
    );
    await wait('!document.querySelector(".photo-preview-image")');
    await clickTrusted(".image-message");
    await wait('!!document.querySelector(".photo-preview-image")');
    await evaluate(
      'window.qaRealNow=Date.now;Date.now=()=>window.qaRealNow()+3601000;document.dispatchEvent(new Event("visibilitychange"))',
    );
    await wait(
      `document.querySelector('[data-message-id="507f1f77bcf86cd799439024"] em')?.textContent==="Image auto deleted"`,
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-image, .image-countdown, .photo-preview-image").length',
      ),
      0,
      "Expiry must remove displayed image bytes and close preview",
    );
    for (const message of chatMessages.filter(
      (message) => message.kind === "image",
    )) {
      message.createdAt = new Date(Date.now() - 3601000).toISOString();
      message.imageExpiresAt = new Date(Date.now() - 1000).toISOString();
    }
    await evaluate(
      'Date.now=window.qaRealNow;document.dispatchEvent(new Event("visibilitychange"))',
    );
    console.log(
      "Image browser checks passed: crop, multipart WebP upload, live countdown, preview, selection rules and automatic expiry placeholder.",
    );
    for (const width of [320, 390]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const headerLayout = await evaluate(
        '(()=>{const h=document.querySelector(".conversationhead"),name=h.querySelector("strong"),old=name.textContent;name.textContent="A very long contact name that must fit into the mobile chat header";const r=name.getBoundingClientRect(),more=document.querySelector(".chat-more-button").getBoundingClientRect();const result={compact:h.getBoundingClientRect().height<=70,truncated:name.scrollWidth>name.clientWidth&&getComputedStyle(name).textOverflow==="ellipsis",clear:r.right<=more.left,hidden:getComputedStyle(document.querySelector(".app-controls-actions")).display==="none",overflow:document.documentElement.scrollWidth>innerWidth};name.textContent=old;return result})()',
      );
      assert.ok(
        headerLayout.compact &&
          headerLayout.truncated &&
          headerLayout.clear &&
          headerLayout.hidden &&
          !headerLayout.overflow,
        "Compact mobile header at " +
          width +
          ": " +
          JSON.stringify(headerLayout),
      );
      await click(".chat-more-button");
      assert.ok(
        await evaluate(
          'document.querySelector(".chat-more-button").getAttribute("aria-expanded")==="true" && document.querySelector(".theme-toggle").getClientRects().length>0',
        ),
      );
      await click(".theme-toggle");
      assert.ok(
        await evaluate(
          'document.querySelector(".chat-more-button").getAttribute("aria-expanded")==="false"',
        ),
      );
      await click(".chat-more-button");
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      assert.ok(
        await evaluate(
          'document.activeElement.matches(".chat-more-button") && document.querySelector(".chat-more-button").getAttribute("aria-expanded")==="false"',
        ),
      );
    }
    console.log(
      "Mobile chat header checks passed: single row, long-name truncation, More dropdown actions and Escape focus restoration.",
    );
    await clickTrusted(".conversationhead .avatar-preview-trigger");
    await wait('document.querySelector(".photo-preview-image img")?.complete');
    await click('.photo-dialog-header-actions button[aria-label="Fullscreen"]');
    await wait('!!document.querySelector(".photo-expanded")');
    await click(
      '.photo-dialog-header-actions button[aria-label="Exit fullscreen"]',
    );
    await wait('!document.querySelector(".photo-expanded")');
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await wait('!document.querySelector(".photo-dialog")');
    assert.ok(
      await evaluate(
        'document.activeElement.matches(".avatar-preview-trigger")',
      ),
      "Closing preview must restore avatar focus",
    );
    console.log(
      "Photo checks passed: cancel without upload, repositioned 512px WebP crop, chat photo preview, fullscreen toggle, Escape and focus restoration.",
    );
    // Long histories must scroll inside the conversation without moving the page.
    for (let index = 0; index < 80; index++) {
      chatMessages.push({
        _id: (1000 + index).toString(16).padStart(24, "0"),
        sender: target,
        content: "Scrollable history message " + index,
        createdAt: new Date(Date.now() + 2000 + index).toISOString(),
      });
    }
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait('document.querySelectorAll(".msgrow").length >= 80');
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [1280, 720],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 800,
      });
      await delay(400);
      const layout = await evaluate(`(() => {
        const area = document.querySelector(".messagearea");
        area.scrollTop = 0;
        const top = area.scrollTop;
        area.scrollTop = area.scrollHeight;
        const composer = document.querySelector(".composer").getBoundingClientRect();
        const header = document.querySelector(".conversationhead").getBoundingClientRect();
        return {
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight: innerHeight,
          pageScroll: scrollY,
          scrollable: area.scrollHeight > area.clientHeight,
          scrolled: area.scrollTop > top,
          headerTop: header.top,
          composerBottom: composer.bottom,
        };
      })()`);
      assert.ok(
        layout.documentHeight <= height + 1,
        "Page must fit viewport at " + width,
      );
      assert.equal(
        layout.pageScroll,
        0,
        "Auto-scroll must leave page fixed at " + width,
      );
      assert.ok(
        layout.scrollable && layout.scrolled,
        "Message history must scroll at " + width,
      );
      assert.ok(
        layout.headerTop >= 0 && layout.composerBottom <= height + 1,
        "Header and composer must remain visible at " + width,
      );
    }
    console.log(
      "Chat scroll checks passed: long histories scroll internally on mobile and desktop; page, header, and composer stay fixed.",
    );
    await click('[aria-label="Go to start screen"]');
    await wait(
      '!!document.querySelector(".nochats") && !document.querySelector(".conversationhead")',
    );
    assert.equal(
      await evaluate('document.querySelectorAll(".chatentry.active").length'),
      0,
      "Logo must clear the active chat",
    );
    await click(".chatentry");
    await wait('!!document.querySelector(".composer")');
    await evaluate(
      'window.qaRetentionNow=Date.now;Date.now=()=>window.qaRetentionNow()+86401000;document.dispatchEvent(new Event("visibilitychange"))',
    );
    await wait(
      'document.querySelectorAll(".messagearea .bubble em").length===0',
    );
    assert.ok(
      await evaluate(
        'Array.from(document.querySelectorAll(".msgrow.own")).every(row=>getComputedStyle(row).display==="none")',
      ),
      "Expired placeholders must leave no empty chat rows",
    );
    const retentionCutoff = Date.now() + 1000;
    for (let index = chatMessages.length - 1; index >= 0; index--) {
      const message = chatMessages[index];
      if (
        (message.deletedAt &&
          Date.parse(message.deletedAt) <= retentionCutoff) ||
        (message.imageExpiresAt &&
          Date.parse(message.imageExpiresAt) <= retentionCutoff)
      )
        chatMessages.splice(index, 1);
    }
    latestChat.latestMessage = chatMessages[chatMessages.length - 1];
    await evaluate(
      'Date.now=window.qaRetentionNow;document.dispatchEvent(new Event("visibilitychange"))',
    );
    console.log(
      "Retention browser checks passed: deleted text and expired image placeholders disappear after 24 hours without empty rows.",
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.ok(
      await evaluate(
        'document.querySelector(".chat-more-button").getClientRects().length>0',
      ),
      "Desktop must use the More dropdown",
    );
    const sharedMessageCount = chatMessages.length;
    await click(".chat-more-button");
    await click('[aria-label="Clear chat"]');
    await click(".chat-confirm-actions .secondary-action");
    assert.ok(
      await evaluate(
        'document.querySelectorAll(".messagearea .msgrow").length>0',
      ),
      "Cancel must keep visible history",
    );
    await click(".chat-more-button");
    await click('[aria-label="Clear chat"]');
    await click(".chat-confirm-actions .danger");
    await wait('document.querySelectorAll(".messagearea .msgrow").length===0');
    assert.equal(
      chatMessages.length,
      sharedMessageCount,
      "Clear must not remove shared messages",
    );
    await fill(".composer input:not([type=file])", "Message after clearing");
    await click(".sendbtn");
    await wait(
      'document.querySelector(".messagearea .bubble p")?.textContent==="Message after clearing"',
    );
    const actionsBeforeBlock = requests.filter((request) =>
      request.path.endsWith("/actions"),
    ).length;
    await click(".chat-more-button");
    await click('[aria-label="Block user"]');
    await click(".chat-confirm-actions .secondary-action");
    assert.equal(
      requests.filter((request) => request.path.endsWith("/actions")).length,
      actionsBeforeBlock,
      "Cancel block must not make an API mutation",
    );
    assert.ok(
      await evaluate(
        '!document.querySelector(".composer input:not([type=file])").disabled',
      ),
    );
    await click(".chat-more-button");
    await click('[aria-label="Block user"]');
    await click(".chat-confirm-actions .danger");
    await wait(
      'document.querySelector(".composer input:not([type=file])").disabled',
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".sendbtn").disabled && document.querySelector(".attach-image").disabled',
      ),
    );
    await click(".chat-more-button");
    await click('[aria-label="Unblock user"]');
    await click(".chat-confirm-actions .primary");
    await wait(
      '!document.querySelector(".composer input:not([type=file])").disabled',
    );
    const directBeforeGroup = latestChat;
    latestChat = {
      _id: "507f1f77bcf86cd799439030",
      chatName: "QA Group",
      isGroup: true,
      users: [
        user,
        target,
        {
          _id: "507f1f77bcf86cd799439014",
          name: "Third member",
          email: "third@example.invalid",
        },
      ],
      groupAdmin: user,
      updatedAt: new Date().toISOString(),
    };
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait(
      'document.querySelector(".chatentry strong")?.textContent==="QA Group"',
    );
    await click(".chatentry");
    await wait(
      'document.querySelector(".conversation-identity strong")?.textContent==="QA Group"',
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[aria-label="Delete group"]').length`,
      ),
      0,
      "Group deletion must stay hidden while other members remain",
    );
    await click(".chat-more-button");
    await click('[aria-label="Rename group"]');
    await fill('[aria-label="Rename group"] input', "QA Group renamed");
    await click('[aria-label="Rename group"] .primary');
    await wait(
      'document.querySelector(".conversation-identity strong")?.textContent==="QA Group renamed"',
    );
    await wait(
      `document.querySelector('[data-message-id="507f1f77bcf86cd799439050"] .bubble p em')?.textContent==="Changed the group name from QA Group to QA Group renamed"`,
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".chatentry .entrytext small em")?.textContent',
      ),
      "Changed the group name from QA Group to QA Group renamed",
    );
    await longPress('[data-message-id="507f1f77bcf86cd799439050"] .bubble');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".chat-selection-actions button").length',
      ),
      0,
      "Automatic activity must not be selectable for editing or deletion",
    );
    assert.ok(
      await evaluate(
        `(()=>{const bubble=document.querySelector('[data-message-id="507f1f77bcf86cd799439050"] .bubble');return bubble.classList.contains("message-deleted")&&!bubble.hasAttribute("tabindex")&&!bubble.querySelector("time,b,.message-meta")})()`,
      ),
      "Activity must match the muted deleted-message appearance without controls or metadata",
    );
    await click(".chat-more-button");
    await click('[aria-label="Rename group"]');
    await click('[aria-label="Rename group"] .primary');
    await wait(
      `!document.querySelector('[role="dialog"][aria-label="Rename group"]')`,
    );
    assert.equal(
      chatMessages.filter((message) => message.kind === "group-rename").length,
      1,
      "Unchanged names must not create duplicate activity messages",
    );
    console.log(
      "Group rename browser checks passed: attributed automatic italic message, updated preview, no text editing and no duplicate on unchanged name.",
    );
    await fill('input[aria-label="Search recent chats"]', "qA gRo");
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".scrolllist .chatentry").length',
      ),
      1,
      "Local search must match group names",
    );
    await click('[aria-label="Clear search"]');

    await click(".chat-more-button");
    await click('[aria-label="Clear group chat"]');
    await click(".chat-confirm-actions .danger");
    await wait('document.querySelectorAll(".messagearea .msgrow").length===0');
    await click(".chat-more-button");
    await click('[aria-label="Leave group"]');
    await click(".chat-confirm-actions .secondary-action");
    assert.ok(
      await evaluate('!!document.querySelector(".conversationhead")'),
      "Cancel must keep group open",
    );
    await click(".chat-more-button");
    await click('[aria-label="Leave group"]');
    await click(".chat-confirm-actions .danger");
    await wait('!document.querySelector(".conversationhead")');
    const remainingHistoryCount = chatMessages.length;
    latestChat = {
      _id: "507f1f77bcf86cd799439031",
      chatName: "Last member group",
      isGroup: true,
      users: [user],
      groupAdmin: user,
      updatedAt: new Date().toISOString(),
    };
    chatMessages.push({
      _id: "507f1f77bcf86cd799439041",
      chat: latestChat._id,
      sender: user,
      content: "Permanent group history",
      createdAt: new Date().toISOString(),
    });
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait(
      'document.querySelector(".chatentry strong")?.textContent==="Last member group"',
    );
    await click(".chatentry");
    await wait(
      'document.querySelector(".conversation-identity strong")?.textContent==="Last member group"',
    );
    await click(".chat-more-button");
    await click('[aria-label="Delete group"]');
    assert.ok(
      await evaluate(
        'document.querySelector(".photo-dialog").textContent.includes("cannot be undone")',
      ),
    );
    await click(".chat-confirm-actions .secondary-action");
    assert.equal(
      chatMessages.length,
      remainingHistoryCount + 1,
      "Cancel must preserve group history",
    );
    await click(".chat-more-button");
    await click('[aria-label="Delete group"]');
    await click(".chat-confirm-actions .danger");
    await wait('!document.querySelector(".conversationhead")');
    assert.equal(
      chatMessages.length,
      remainingHistoryCount,
      "Group deletion must preserve unrelated conversations",
    );
    console.log(
      "Delete group browser checks passed: only the final member sees it, cancellation keeps history, confirmation removes the group.",
    );
    latestChat = directBeforeGroup;
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait('!!document.querySelector(".chatentry")');
    await click(".chatentry");
    await wait('!!document.querySelector(".composer")');
    console.log(
      "Chat actions browser checks passed: desktop dropdown, private clear and new messages, block/unblock controls, group clear and confirmed exit.",
    );
    await click(".chat-more-button");
    await click('.app-controls-actions [aria-label="Sign out"]');
    await wait(
      'document.querySelector(".photo-dialog h3")?.textContent==="Sign out?"',
    );
    await click(".signout-confirm-actions .secondary-action");
    assert.equal(
      requests.filter((request) => request.path === "/api/auth/logout").length,
      0,
      "Cancel sign out must not call the logout API",
    );
    await click(".chat-more-button");
    await click('[aria-label="Open your account"]');
    await click(".profile-signout");
    await click(".signout-confirm-actions .secondary-action");
    assert.ok(
      await evaluate('!!document.querySelector(".profile-editor")'),
      "Cancel sign out must preserve the profile popup",
    );
    assert.equal(
      requests.filter((request) => request.path === "/api/auth/logout").length,
      0,
    );
    failNextLogout = true;
    await click(".profile-signout");
    await click(".signout-confirm-actions .primary");
    await wait(
      'document.querySelector(".photo-dialog .error")?.textContent.includes("Not found")',
    );
    assert.ok(
      await evaluate(
        '!!document.querySelector(".shell") && !!document.querySelector(".profile-editor")',
      ),
      "Failed logout must keep the current session and profile",
    );
    await click(".signout-confirm-actions .primary");
    await wait('!!document.querySelector(".authcard")');
    assert.equal(
      requests.filter((request) => request.path === "/api/auth/logout").length,
      2,
    );
    await fill('.authcard input[name="email"]', user.email);
    await fill('.authcard input[name="password"]', "New-password-123");
    await click(".authcard .primary");
    await wait('!!document.querySelector(".chatentry")');
    await click(".chatentry");
    await wait('!!document.querySelector(".composer")');
    console.log(
      "Confirmation checks passed: header/profile sign-out cancellation, failed logout preservation, confirmed logout, and canceled blocking without API writes.",
    );
    const savedTarget = { ...target };
    Object.assign(target, {
      name: "Deleted account",
      email: "",
      image: "",
      deletedAt: new Date().toISOString(),
    });
    latestChat.accountPurgeAt = new Date(
      Date.now() + 15 * 86400000,
    ).toISOString();
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait(
      'document.querySelector(".composer input:not([type=file])")?.disabled===true',
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".composer input:not([type=file])").placeholder',
      ),
      "User account deleted",
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".sendbtn").disabled && document.querySelector(".attach-image").disabled',
      ),
    );
    assert.ok(
      await evaluate(
        'document.querySelector(".account-history-warning").textContent.includes("15 days")',
      ),
    );
    delete target.deletedAt;
    Object.assign(target, savedTarget);
    delete latestChat.accountPurgeAt;
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await wait(
      'document.querySelector(".composer input:not([type=file])")?.disabled===false',
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await click(".chat-more-button");
    await click('[aria-label="Open your account"]');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".profile-tabs button").length',
      ),
      4,
    );
    await click('.profile-tabs button[aria-label="Delete account"]');
    assert.ok(
      await evaluate(
        'document.querySelector(".profile-delete-account").textContent.includes("15 days")',
      ),
    );
    await fill('input[name="deleteAccountPassword"]', "New-password-123");
    await click(".account-delete-ack input");
    await click(".profile-delete-account button[type=submit]");
    await wait(
      'document.querySelector(".photo-dialog h3")?.textContent.includes("Permanently delete")',
    );
    await click(".photo-dialog-actions .secondary-action");
    assert.equal(
      requests.filter((request) => request.path === "/api/profile/account")
        .length,
      0,
      "Cancel must not delete an account",
    );
    await click(".profile-delete-account button[type=submit]");
    await click(".photo-dialog-actions .danger");
    await wait('!!document.querySelector(".authcard")');
    assert.equal(
      requests.filter(
        (request) =>
          request.path === "/api/profile/account" &&
          request.method === "DELETE",
      ).length,
      1,
    );
    console.log(
      "Account deletion browser checks passed: fourth tab, warnings, password, acknowledgment, final confirmation, cancellation, sign-out and read-only peer chat.",
    );
    authenticated = false;
    await send("Page.navigate", { url: base + "/?connect=" + target._id });
    await wait('!!document.querySelector(".authcard .contact-signin-note")');
    await fill('.authcard input[name="email"]', user.email);
    await fill('.authcard input[name="password"]', "Original-password");
    await click(".authcard .primary");
    await wait(
      'document.querySelector(".contact-preview-person h4")?.textContent==="QR Contact"',
    );
    authenticated = false;
    await send("Page.navigate", { url: base });
    await wait('!!document.querySelector(".authcard")');
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [1024, 600],
      [1280, 720],
      [1366, 768],
      [1920, 1080],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 800,
      });
      await delay(100);
      for (const mode of ["login", "register"]) {
        if (mode === "register") await click(".authswitch button");
        const layout = await evaluate(`(()=>{
          const card=document.querySelector('.authcard').getBoundingClientRect(),controls=document.querySelector('.app-controls').getBoundingClientRect(),input=document.querySelector('.authcard input');
          return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth,cardHeight:card.height,cardBottom:card.bottom,controlsClear:card.top>=controls.bottom,inputSize:parseFloat(getComputedStyle(input).fontSize),tapHeight:input.getBoundingClientRect().height,documentHeight:document.documentElement.scrollHeight,headline:parseFloat(getComputedStyle(document.querySelector(".authhero h1")).fontSize)};
        })()`);
        assert.equal(
          layout.horizontalOverflow,
          false,
          mode + " overflow at " + width,
        );
        assert.equal(layout.controlsClear, true);
        assert.ok(
          layout.cardBottom <= height,
          mode + " should fit screen: " + JSON.stringify(layout),
        );
        assert.ok(layout.tapHeight >= 44);
        if (width <= 800) assert.ok(layout.inputSize >= 16);
        else {
          assert.ok(layout.headline <= 44);
          assert.ok(
            layout.documentHeight <= height,
            mode +
              " must not scroll at " +
              width +
              "x" +
              height +
              ": " +
              JSON.stringify(layout),
          );
        }
      }
      await click(".authswitch button");
    }
    const manifestReport = await send("Page.getAppManifest");
    assert.deepEqual(manifestReport.errors, []);
    const manifest = JSON.parse(manifestReport.data);
    assert.equal(manifest.display, "standalone");
    assert.ok(
      manifest.icons.some(
        (icon) => icon.sizes === "192x192" && icon.purpose === "any",
      ),
    );
    assert.ok(
      manifest.icons.some(
        (icon) => icon.sizes === "512x512" && icon.purpose === "any",
      ),
    );
    assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
    const links = await evaluate(
      `({favicon:!!document.querySelector('link[rel="icon"][href="/icon.svg?v=3"]'),apple:!!document.querySelector('link[rel="apple-touch-icon"]')})`,
    );
    assert.equal(links.favicon, true);
    assert.equal(links.apple, true);
    await evaluate("navigator.serviceWorker.ready.then(()=>true)");
    await wait("!!navigator.serviceWorker.controller");
    const installability = await send("Page.getInstallabilityErrors");
    assert.deepEqual(
      installability.installabilityErrors,
      [],
      "Browser installability check must pass",
    );
    const assets = await evaluate(
      '(async()=>{const manifest=await (await fetch("/manifest.webmanifest")).json();return await Promise.all(manifest.icons.map(async icon=>({src:icon.src,ok:(await fetch(icon.src)).ok})))})()',
    );
    assert.equal(
      assets.every((asset) => asset.ok),
      true,
    );
    const workerTargets = (
      await send("Target.getTargets", {}, null)
    ).targetInfos.filter(
      (target) =>
        target.type === "service_worker" && target.url.startsWith(base),
    );
    assert.ok(workerTargets.length > 0);
    const workerSessions = [];
    for (const target of workerTargets) {
      const attached = await send(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
        null,
      );
      workerSessions.push(attached.sessionId);
      await send("Network.enable", {}, attached.sessionId);
      await send(
        "Network.emulateNetworkConditions",
        {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        },
        attached.sessionId,
      );
    }
    await send("Network.enable");
    await send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await send("Page.navigate", { url: base + "/" });
    await wait('document.body?.innerText.includes("You are offline")');
    await wait(
      'document.querySelector(".card img")?.complete && document.querySelector(".card img").naturalWidth > 0',
    );
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    for (const workerSession of workerSessions)
      await send(
        "Network.emulateNetworkConditions",
        {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        },
        workerSession,
      );
    await click(".card button");
    await wait('!!document.querySelector(".authcard")');
    console.log(
      "PWA checks passed: manifest, favicon, Apple icon, installability, icon URLs, service-worker registration, offline launch and reconnect.",
    );
    assert.deepEqual(exceptions, []);
    console.log(
      "Browser checks passed: compact mobile header, profile edit, real canvas WebP upload, password form, QR preview, fake camera lifecycle, uploaded QR decoding, opening a conversation and contact-link continuation after login. API writes were mocked.",
    );
    await send("Browser.close", {}, null).catch(() => {});
  } finally {
    ws?.close();
    browser.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
