/**
 * Pack a staged extension directory into the store ZIP.
 *
 * Written by hand rather than shelling out to `web-ext build`, for one reason that
 * was measured rather than assumed: `web-ext build` will package whatever it is
 * pointed at, and its defaults exclude `node_modules/` and dotfiles but NOT
 * `docs/`, `test/` or `tools/`. Pointed at the repository root it produced a
 * package containing 88 development files. Works, ships the wrong thing.
 *
 * So the staging step owns the exclusion list (`SHIPPED` in the Makefile) and this
 * does the zipping, with the manifest at the archive root as both stores require.
 *
 * No `zip` binary is needed — there is not one on this machine — so this uses
 * Node's own zlib through the archive format. Deflate, because the two dictionaries
 * are 4 MB of JSON and compress well.
 *
 * @see Makefile — `make pack`
 */

import { createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const [sourceDir, outFile, version] = process.argv.slice(2);
if (!sourceDir || !outFile) {
  console.error('usage: node tools/pack.mjs <staged-dir> <out.zip> [version]');
  process.exit(1);
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * One ZIP entry: local header + deflated data.
 *
 * A stored (uncompressed) entry is used for anything that does not shrink, because
 * deflate can make small or already-compressed files larger and there is no reason
 * to pay for that.
 *
 * @param {string} name Path inside the archive, forward slashes.
 * @param {Buffer} data
 * @returns {{local: Buffer, central: Buffer, size: number}}
 */
function entry(name, data) {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;

  const deflated = deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const payload = stored ? data : deflated;
  const method = stored ? 0 : 8;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0x2100, 12); // mod date — a fixed date, so builds are reproducible
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x2100, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  // `>>> 0` because JS bitwise operators are 32-bit SIGNED, so `0o100644 << 16`
  // overflows to a negative number and `writeUInt32LE` rejects it. The value is
  // the regular-file mode in the high bits, which is what unzip and both stores
  // read to decide a entry is a file rather than a directory.
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);

  return {
    local: Buffer.concat([local, nameBytes, payload]),
    central: Buffer.concat([central, nameBytes]),
    size: data.length,
  };
}

const files = walk(sourceDir).sort();
if (!files.length) {
  console.error(`nothing to pack in ${sourceDir}`);
  process.exit(1);
}

const locals = [];
const centrals = [];
let uncompressed = 0;

for (const file of files) {
  // Forward slashes regardless of platform: the archive format requires them, and
  // a Windows build would otherwise produce a ZIP neither store can read.
  const name = relative(sourceDir, file).split(sep).join('/');
  const data = readFileSync(file);
  const built = entry(name, data);
  locals.push(built.local);
  centrals.push(built.central);
  uncompressed += built.size;
}

// The manifest has to be at the archive root. Both stores reject a package where
// it is nested, and the failure reads as "invalid manifest" rather than "wrong
// layout" — so it is asserted here rather than discovered at upload.
if (!files.some((file) => relative(sourceDir, file) === 'manifest.json')) {
  console.error('manifest.json is not at the root of the staged directory');
  process.exit(1);
}

const central = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(centrals.length, 8);
end.writeUInt16LE(centrals.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(locals.reduce((n, b) => n + b.length, 0), 16);
end.writeUInt16LE(0, 20);

const out = createWriteStream(outFile);
out.write(Buffer.concat([...locals, central, end]));
await new Promise((resolve, reject) => {
  out.on('finish', resolve);
  out.on('error', reject);
  out.end();
});

const written = statSync(outFile).size;
console.log(
  `packed ${files.length} files, ${(uncompressed / 1e6).toFixed(1)} MB -> ${(written / 1e6).toFixed(1)} MB` +
    (version ? ` (v${version})` : ''),
);
