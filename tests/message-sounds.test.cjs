const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(
  path.join(__dirname, "../src/lib/message-sounds.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const exportsObject = {};
vm.runInNewContext(compiled, { exports: exportsObject });
const { createMessageSoundTracker, createMessageSoundPlayer } = exportsObject;
const msg = (id, sender = "other", second = Number(id)) => ({
  _id: String(id).padStart(3, "0"),
  sender: { _id: sender },
  createdAt: new Date(1700000000000 + second * 1000).toISOString(),
});
const chat = (message, id = "chat") => ({ _id: id, latestMessage: message });
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fakePlayer() {
  const audio = [],
    listeners = new Map();
  const target = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const makeAudio = (src) => {
    const track = {
      src,
      muted: false,
      currentTime: 4,
      plays: [],
      pauses: 0,
      loads: 0,
      fail: false,
      pending: null,
      play() {
        this.plays.push({ muted: this.muted, time: this.currentTime });
        return (
          this.pending ||
          (this.fail
            ? Promise.reject(new Error("NotAllowedError"))
            : Promise.resolve())
        );
      },
      pause() {
        this.pauses++;
      },
      removeAttribute(name) {
        if (name === "src") this.src = "";
      },
      load() {
        this.loads++;
      },
    };
    audio.push(track);
    return track;
  };
  const player = createMessageSoundPlayer({ makeAudio, target });
  return {
    player,
    audio,
    listeners,
    gesture: () => listeners.get("pointerdown")?.(),
  };
}

test("existing message history on login is silent", () => {
  const t = createMessageSoundTracker("me");
  assert.equal(t.observe([chat(msg(1)), chat(msg(2), "second")]), false);
  assert.equal(t.observe([chat(msg(1)), chat(msg(2), "second")]), false);
});
test("new messages in any conversation alert once; duplicate refreshes stay silent", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(1)), chat(msg(2), "second")]);
  const snapshot = [chat(msg(1)), chat(msg(3), "second")];
  assert.equal(t.observe(snapshot), true);
  assert.equal(t.observe(snapshot), false);
});
test("own messages, profile changes and group renames do not alert", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(1))]);
  assert.equal(t.observe([{ ...chat(msg(1)), chatName: "Renamed" }]), false);
  assert.equal(t.observe([chat(msg(2, "me"))]), false);
});
test("a message arriving in a previously empty chat or a new chat alerts", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(null)]);
  assert.equal(t.observe([chat(msg(1))]), true);
  assert.equal(t.observe([chat(msg(2), "new")]), true);
});
test("reordered old snapshots never move the watermark backward or replay an alert", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(1))]);
  assert.equal(t.observe([chat(msg(3))]), true);
  assert.equal(t.observe([chat(msg(2))]), false);
  assert.equal(t.observe([chat(msg(3))]), false);
  assert.equal(t.observe([chat(msg(4))]), true);
});
test("older history from a newly listed chat remains silent", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(10))]);
  assert.equal(t.observe([chat(msg(2), "old")]), false);
  assert.equal(t.observe([chat(msg(11), "new")]), true);
});
test("messages saved locally suppress echoes and stale snapshots", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(1))]);
  t.sent("chat", msg(3, "me"));
  assert.equal(t.observe([chat(msg(2))]), false);
  assert.equal(t.observe([chat(msg(3, "me"))]), false);
  assert.equal(t.observe([chat(msg(4))]), true);
});
test("same-timestamp messages are ordered by their MongoDB IDs", () => {
  const t = createMessageSoundTracker("me");
  t.observe([chat(msg(1, "other", 1))]);
  assert.equal(t.observe([chat(msg(2, "other", 1))]), true);
  assert.equal(t.observe([chat(msg(1, "other", 1))]), false);
});
test("bursts produce one alert and a new session starts with a silent baseline", () => {
  const t = createMessageSoundTracker("me");
  t.observe([]);
  const snapshot = [chat(msg(1)), chat(msg(2), "second")];
  assert.equal(t.observe(snapshot), true);
  assert.equal(t.observe(snapshot), false);
  assert.equal(createMessageSoundTracker("me").observe(snapshot), false);
});
test("invalid summary timestamps do not cause notifications", () => {
  const t = createMessageSoundTracker("me");
  t.observe([]);
  assert.equal(t.observe([chat({ ...msg(1), createdAt: "invalid" })]), false);
});
test("the player uses the requested MP3 files and resets each playback", () => {
  const f = fakePlayer();
  f.player.received();
  f.player.sent();
  assert.equal(f.audio[0].src, "/audio/alert.mp3");
  assert.equal(f.audio[1].src, "/audio/sentmessage.mp3");
  assert.equal(f.audio[0].plays[0].time, 0);
  assert.equal(f.audio[1].plays[0].time, 0);
  assert.equal(f.audio[0].volume, 0.6);
  f.player.dispose();
});
test("a user gesture silently primes the reusable audio elements once", async () => {
  const f = fakePlayer();
  f.gesture();
  await settle();
  for (const track of f.audio) {
    assert.equal(track.plays[0].muted, true);
    assert.equal(track.pauses, 1);
    assert.equal(track.muted, false);
  }
  assert.equal(f.listeners.size, 0);
  f.gesture();
  assert.equal(f.audio[0].plays.length, 1);
  f.player.dispose();
});
test("a sound requested during priming waits and then plays unmuted", async () => {
  const f = fakePlayer();
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  f.audio[1].pending = pending;
  f.gesture();
  f.player.sent();
  assert.equal(f.audio[1].plays.length, 1);
  resolve();
  await settle();
  assert.equal(f.audio[1].plays.length, 2);
  assert.equal(f.audio[1].plays[1].muted, false);
  f.player.dispose();
});
test("browser autoplay rejection is caught and never blocks the app", async () => {
  const f = fakePlayer();
  f.audio.forEach((track) => {
    track.fail = true;
  });
  f.player.received();
  f.player.sent();
  f.gesture();
  await settle();
  assert.equal(f.listeners.size, 2);
  f.audio.forEach((track) => {
    track.fail = false;
  });
  f.gesture();
  await settle();
  assert.equal(f.listeners.size, 0);
  f.player.dispose();
});
test("cleanup releases audio and prevents late sounds after logout", async () => {
  const f = fakePlayer();
  let resolve;
  f.audio[0].pending = new Promise((done) => {
    resolve = done;
  });
  f.gesture();
  f.player.received();
  f.player.dispose();
  resolve();
  await settle();
  assert.equal(f.audio[0].plays.length, 1);
  f.player.sent();
  assert.equal(f.audio[1].plays.length, 1);
  assert.equal(f.listeners.size, 0);
  for (const track of f.audio) {
    assert.equal(track.src, "");
    assert.equal(track.loads, 1);
  }
});
test("both notification sound files are present and nonempty", () => {
  for (const file of ["alert.mp3", "sentmessage.mp3"])
    assert.ok(
      fs.statSync(path.join(__dirname, "../public/audio", file)).size > 0,
    );
});
