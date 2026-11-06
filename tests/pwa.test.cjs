const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "public/icon.svg"));
const square = Buffer.from(svg.toString().replace(' rx="52"', ""));
async function equalPixels(actual, source, size) {
  const [a, b] = await Promise.all([
    sharp(actual).ensureAlpha().raw().toBuffer(),
    sharp(source).resize(size, size).ensureAlpha().raw().toBuffer(),
  ]);
  assert.equal(
    a.equals(b),
    true,
    "Icon must be rendered from the shared app logo",
  );
}
test("192px and 512px install icons match the shared app logo", async () => {
  for (const size of [192, 512]) {
    const file = path.join(root, "public/icons/icon-" + size + ".png");
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    await equalPixels(file, svg, size);
  }
});
test("Apple and maskable icons use the same glyph on a full-bleed background", async () => {
  await equalPixels(
    path.join(root, "public/icons/apple-touch-icon.png"),
    square,
    180,
  );
  await equalPixels(
    path.join(root, "public/icons/icon-maskable-512.png"),
    square,
    512,
  );
});
test("maskable icon keeps its white glyph inside the Android safe zone", async () => {
  const { data, info } = await sharp(
    path.join(root, "public/icons/icon-maskable-512.png"),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      assert.equal(data[i + 3], 255);
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        white++;
        assert.ok(
          Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) <=
            info.width * 0.4,
        );
      }
    }
  assert.ok(white > 100);
});
test("favicon includes matching 16px, 32px and 48px app logos", async () => {
  const ico = fs.readFileSync(path.join(root, "public/favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  for (let i = 0; i < 3; i++) {
    const at = 6 + i * 16,
      size = ico[at],
      bytes = ico.readUInt32LE(at + 8),
      offset = ico.readUInt32LE(at + 12);
    assert.equal(size, [16, 32, 48][i]);
    await equalPixels(ico.subarray(offset, offset + bytes), svg, size);
  }
});
