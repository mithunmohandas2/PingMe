const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const sharp = require("sharp");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const jsQR = require("jsqr");

function load(file, stubs = {}, globals = {}) {
  const filename = path.resolve(__dirname, "..", file);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (name) => (name in stubs ? stubs[name] : require(name)),
      process,
      console,
      Buffer,
      TextEncoder,
      URL,
      Request,
      Response,
      File,
      Blob,
      ...globals,
    },
    { filename },
  );
  return module.exports;
}
const id = "507f1f77bcf86cd799439011";
const otherId = "507f1f77bcf86cd799439012";
const origin = "https://pingme.example";
const contacts = load("src/lib/contacts.ts");
const validation = load("src/lib/profile-validation.ts");
const http = {
  json: (data, status = 200) => Response.json(data, { status }),
  fail: (message, status = 400) => Response.json({ message }, { status }),
  body: async (req) => {
    try {
      return await req.json();
    } catch {
      return null;
    }
  },
  serverError: (error) => {
    throw error;
  },
  oid: (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value),
};
const request = (pathname, data, method = "PATCH", from = origin) =>
  new Request(origin + pathname, {
    method,
    headers: { "Content-Type": "application/json", Origin: from },
    body: JSON.stringify(data),
  });
async function fixture(authorized = true) {
  const user = {
    _id: id,
    name: "Original Name",
    email: "old@example.com",
    bio: "",
    image: "",
    password: await bcrypt.hash("Original-password", 4),
    sessionVersion: 0,
  };
  let writes = 0,
    savedImage,
    revoked = false;
  const User = {
    findById: async () => ({ ...user }),
    findOneAndUpdate: async (filter, update) => {
      assert.equal(filter._id, id);
      if (filter.password !== user.password) return null;
      writes++;
      Object.assign(user, update.$set);
      if (update.$inc?.sessionVersion)
        user.sessionVersion += update.$inc.sessionVersion;
      return { ...user };
    },
    findByIdAndUpdate: async (target, update) => {
      assert.equal(target, id);
      writes++;
      Object.assign(user, update.$set);
      return { ...user };
    },
  };
  const ProfileImage = {
    findOneAndUpdate: async (filter, update) => {
      assert.equal(filter._id, id);
      savedImage = update.$set.data;
    },
    deleteOne: async (filter) => {
      assert.equal(filter._id, id);
      savedImage = undefined;
    },
    findById: async () => (savedImage ? { data: savedImage } : null),
  };
  const stubs = {
    "@/lib/auth": {
      requireUser: async () => (authorized ? id : null),
      safeUser: (value) => ({
        _id: value._id,
        name: value.name,
        email: value.email,
        bio: value.bio,
        image: value.image,
      }),
      assertAuthConfigured() {},
      createToken: async (id, version) => `token:${id}:${version}`,
      setSession: (res, token) =>
        res.headers.set("Set-Cookie", "session=" + token),
    },
    "@/lib/models": { User, ProfileImage },
    "@/lib/http": http,
    "@/lib/profile-validation": validation,
    "@/lib/profile-updates": { notifyProfileUpdate: async () => {} },
    "@/lib/realtime": {
      revokeUserSessions: async () => {
        revoked = true;
      },
    },
    "@/lib/db": { connectDb: async () => {} },
  };
  return {
    user,
    stubs,
    writes: () => writes,
    image: () => savedImage,
    revoked: () => revoked,
  };
}

test("contact links round trip and reject foreign origins, scripts, paths and invalid IDs", () => {
  const link = contacts.contactLink(origin, id);
  assert.equal(contacts.parseContactLink(link, origin), id);
  for (const link of [
    `https://evil.example/?connect=${id}`,
    `javascript:alert(1)`,
    `${origin}/other?connect=${id}`,
    `${origin}/?connect=invalid`,
    `${origin}/?connect=${id}extra`,
  ])
    assert.equal(contacts.parseContactLink(link, origin), null);
  assert.throws(() => contacts.contactLink(origin, "invalid"));
});

test("generated contact QR codes decode to the same shareable link", async () => {
  const link = contacts.contactLink(origin, id);
  const png = await QRCode.toBuffer(link, { width: 320, margin: 4 });
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(
    jsQR(new Uint8ClampedArray(data), info.width, info.height).data,
    link,
  );
});

test("profile schema trims names and rejects invalid email and overly long bios", () => {
  assert.equal(
    validation.profileSchema.parse({
      name: "  New Name  ",
      email: "NEW@example.com",
    }).name,
    "New Name",
  );
  assert.equal(
    validation.profileSchema.safeParse({ name: "A", email: "bad" }).success,
    false,
  );
  assert.equal(
    validation.profileSchema.safeParse({
      name: "Name",
      email: "me@example.com",
      bio: "x".repeat(161),
    }).success,
    false,
  );
  assert.equal(
    validation.passwordSchema.safeParse({
      currentPassword: "old",
      newPassword: "🔒".repeat(20),
    }).success,
    false,
  );
});

test("profile updates require authentication and reject cross-origin requests", async () => {
  const f = await fixture(false),
    route = load("src/app/api/profile/route.ts", f.stubs);
  assert.equal((await route.PATCH(request("/api/profile", {}))).status, 401);
  assert.equal(
    (
      await route.PATCH(
        request("/api/profile", {}, "PATCH", "https://evil.example"),
      )
    ).status,
    403,
  );
  assert.equal(f.writes(), 0);
});

test("name and bio updates affect only the authenticated account", async () => {
  const f = await fixture(),
    route = load("src/app/api/profile/route.ts", f.stubs);
  const response = await route.PATCH(
    request("/api/profile", {
      _id: otherId,
      name: "Updated Name",
      email: f.user.email,
      bio: "Hello there",
    }),
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data._id, id);
  assert.equal(result.data.bio, "Hello there");
  assert.equal(result.data.password, undefined);
});

test("changing email requires the correct current password", async () => {
  const f = await fixture(),
    route = load("src/app/api/profile/route.ts", f.stubs);
  const payload = { name: f.user.name, email: "new@example.com" };
  assert.equal(
    (await route.PATCH(request("/api/profile", payload))).status,
    400,
  );
  assert.equal(
    (
      await route.PATCH(
        request("/api/profile", { ...payload, currentPassword: "wrong" }),
      )
    ).status,
    400,
  );
  assert.equal(f.writes(), 0);
  assert.equal(
    (
      await route.PATCH(
        request("/api/profile", {
          ...payload,
          currentPassword: "Original-password",
        }),
      )
    ).status,
    200,
  );
  assert.equal(f.user.email, "new@example.com");
});

test("password changes verify current password and reject reused or short passwords", async () => {
  const f = await fixture(),
    route = load("src/app/api/profile/password/route.ts", f.stubs);
  for (const payload of [
    { currentPassword: "wrong", newPassword: "Different-password" },
    { currentPassword: "Original-password", newPassword: "Original-password" },
    { currentPassword: "Original-password", newPassword: "short" },
  ])
    assert.equal(
      (await route.PUT(request("/api/profile/password", payload, "PUT")))
        .status,
      400,
    );
  assert.equal(f.writes(), 0);
});

test("successful password changes store a hash, advance session version and rotate the cookie", async () => {
  const f = await fixture(),
    route = load("src/app/api/profile/password/route.ts", f.stubs);
  const response = await route.PUT(
    request(
      "/api/profile/password",
      {
        currentPassword: "Original-password",
        newPassword: "Different-password",
      },
      "PUT",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(
    await bcrypt.compare("Different-password", f.user.password),
    true,
  );
  assert.equal(f.user.sessionVersion, 1);
  assert.match(response.headers.get("Set-Cookie"), /:1$/);
  assert.equal(f.revoked(), true);
});

test("old JWT sessions are rejected after password change while new sessions stay valid", async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET =
    "profile-test-secret-that-is-long-enough-for-signing";
  try {
    let token,
      storedVersion = 0;
    const auth = load("src/lib/auth.ts", {
      jose: await import("jose"),
      "next/headers": {
        cookies: async () => ({ get: () => ({ value: token }) }),
      },
      "./db": { connectDb: async () => {} },
      "./models": {
        User: {
          exists: async (query) =>
            query._id === id &&
            (query.$or
              ? storedVersion === 0
              : query.sessionVersion === storedVersion),
        },
      },
    });
    token = await auth.createToken(id);
    assert.equal(await auth.requireUser(), id);
    storedVersion = 1;
    assert.equal(await auth.requireUser(), null);
    token = await auth.createToken(id, 1);
    assert.equal(await auth.requireUser(), id);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("avatar API validates WebP content, compresses persistently, serves and removes the photo", async () => {
  const f = await fixture(),
    route = load("src/app/api/profile/avatar/route.ts", f.stubs);
  const upload = (file) => {
    const form = new FormData();
    form.set("image", file);
    return new Request(origin + "/api/profile/avatar", {
      method: "POST",
      body: form,
      headers: { Origin: origin },
    });
  };
  const png = await sharp({
    create: { width: 900, height: 700, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  assert.equal(
    (
      await route.POST(
        upload(new File([png], "fake.webp", { type: "image/webp" })),
      )
    ).status,
    400,
  );
  const webp = await sharp(png).webp().toBuffer();
  assert.equal(
    (
      await route.POST(
        upload(new File([webp], "photo.webp", { type: "image/webp" })),
      )
    ).status,
    200,
  );
  const meta = await sharp(f.image()).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  assert.match(f.user.image, /\/avatar\?v=/);
  const serving = load("src/app/api/users/[userId]/avatar/route.ts", f.stubs);
  const response = await serving.GET(new Request(origin), {
    params: Promise.resolve({ userId: id }),
  });
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.equal((await response.arrayBuffer()).byteLength, f.image().length);
  assert.equal(
    (
      await route.DELETE(
        new Request(origin + "/api/profile/avatar", { method: "DELETE" }),
      )
    ).status,
    200,
  );
  assert.equal(f.user.image, "");
  assert.equal(f.image(), undefined);
});

test("avatar uploads reject unauthenticated and oversized requests", async () => {
  const f = await fixture(false),
    route = load("src/app/api/profile/avatar/route.ts", f.stubs);
  assert.equal(
    (
      await route.POST(
        new Request(origin + "/api/profile/avatar", { method: "POST" }),
      )
    ).status,
    401,
  );
  const allowed = await fixture(),
    allowedRoute = load("src/app/api/profile/avatar/route.ts", allowed.stubs);
  assert.equal(
    (
      await allowedRoute.POST(
        new Request(origin + "/api/profile/avatar", {
          method: "POST",
          headers: { "Content-Length": String(3 * 1024 * 1024) },
        }),
      )
    ).status,
    413,
  );
});

async function compressionFixture(input) {
  const data = Buffer.from(await input.arrayBuffer()),
    meta = await sharp(data).metadata();
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback, type, quality) {
      sharp(data)
        .resize(canvas.width, canvas.height)
        .webp({ quality: Math.round(quality * 100) })
        .toBuffer()
        .then((buffer) => callback(new Blob([buffer], { type })));
    },
  };
  const helper = load(
    "src/lib/compress-image.ts",
    {},
    {
      createImageBitmap: async () => ({
        width: meta.width,
        height: meta.height,
        close: () => {
          closed = true;
        },
      }),
      document: { createElement: () => canvas },
    },
  );
  return { helper, closed: () => closed };
}

test("small JPEG photos are converted to WebP instead of bypassing conversion", async () => {
  const bytes = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const file = new File([bytes], "photo.jpg", { type: "image/jpeg" }),
    f = await compressionFixture(file);
  const result = await f.helper.compressImage(file);
  assert.equal(result.type, "image/webp");
  assert.equal(result.name, "photo.webp");
  assert.equal(
    (await sharp(Buffer.from(await result.arrayBuffer())).metadata()).format,
    "webp",
  );
  assert.equal(f.closed(), true);
});

test("portrait avatars resize their longest edge and small WebP images are kept", async () => {
  const bytes = await sharp({
    create: { width: 600, height: 1800, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const file = new File([bytes], "portrait.png", { type: "image/png" }),
    f = await compressionFixture(file);
  const result = await f.helper.compressImage(file, { maxWidth: 512 });
  const meta = await sharp(Buffer.from(await result.arrayBuffer())).metadata();
  assert.equal(meta.height, 512);
  assert.ok(meta.width <= 512);
  const smaller = await compressionFixture(result);
  assert.equal(
    await smaller.helper.compressImage(result, { maxWidth: 512 }),
    result,
  );
  assert.equal(smaller.closed(), true);
});

test("non-image files are rejected before decoding", async () => {
  const helper = load("src/lib/compress-image.ts");
  await assert.rejects(
    helper.compressImage(
      new File(["bad"], "file.svg", { type: "image/svg+xml" }),
    ),
    /JPEG, PNG or WebP/,
  );
});
