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
    const chatMessages = [];
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
      else if (url.pathname === "/api/auth/login") {
        authenticated = true;
        data = user;
      } else if (url.pathname === "/api/chats" && request.method === "GET")
        data = latestChat ? [latestChat] : [];
      else if (url.pathname === "/api/profile/avatar") {
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
      } else if (url.pathname.startsWith("/api/messages/")) data = chatMessages;
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
        `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
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
        'document.querySelectorAll(".app-controls button").length',
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
          overflow:modal.scrollWidth>modal.clientWidth,twoColumns:Math.abs(fields.children[0].getBoundingClientRect().top-fields.children[1].getBoundingClientRect().top)<1,
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
      'document.querySelector(".profile-success")?.textContent.includes("Profile updated")',
    );
    assert.equal(user.name, "Updated Browser Name");
    await upload('input[aria-label="Choose profile photo"]', photo);
    await wait(
      'document.querySelector(".profile-success")?.textContent.includes("photo updated")',
    );
    assert.ok(
      requests.some(
        (request) =>
          request.path === "/api/profile/avatar" &&
          request.contentType.includes("multipart/form-data"),
      ),
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
      'document.querySelector(".profile-success")?.textContent.includes("Password changed")',
    );
    await evaluate(
      'document.querySelectorAll(".profile-tabs button")[2].click()',
    );
    await wait('document.querySelector(".contact-qr img")?.complete');
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
    await fill(".composer input", "Sound test message");
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
    await fill(".composer input", "Failed send must stay silent");
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
