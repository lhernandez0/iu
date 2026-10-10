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
 * No `zip` binary is needed, there is not one on this machine, so this uses
 * Node's own zlib through the archive format. Deflate, because the two dictionaries
 * are 4 MB of JSON and compress well.
 *
 * @see Makefile, `make pack`
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
 * DOS-format date and time for the archive entries.
 *
 * A fixed value, so two builds of the same source are byte-identical, that is
 * deliberate and worth keeping.
 *
 * **The value matters, and the original was wrong.** DOS packs the date as
 * `year-1980` in the top 7 bits, month in the next 4, day in the low 5, so
 * `0x2100` decodes to 1996, month 8, **day 0**, which is not a date at all.
 * `unzip -l` printed `1996-08-00` and every entry carried it.
 *
 * `0x5021` is 2020-01-01: `(40 << 9) | (1 << 5) | 1`. The time is midnight.
 */
const FIXED_TIME = 0x0000;
const FIXED_DATE = 0x5021;

/**
 * One ZIP entry: local header + payload, and the matching central directory
 * record.
 *
 * A stored (uncompressed) entry is used for anything that does not shrink, because
 * deflate can make small or already-compressed files larger and there is no reason
 * to pay for that.
 *
 * @param {string} name Path inside the archive, forward slashes.
 * @param {Buffer} data
 * @param {number} offset Byte offset of this entry's local header from the file start.
 * @returns {{local: Buffer, central: Buffer, size: number}}
 */
function entry(name, data, offset) {
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
  local.writeUInt16LE(FIXED_TIME, 10); // mod time
  local.writeUInt16LE(FIXED_DATE, 12); // mod date
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
  central.writeUInt16LE(FIXED_TIME, 12);
  central.writeUInt16LE(FIXED_DATE, 14);
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
  // read to decide an entry is a file rather than a directory.
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  // **The field that was missing.** Byte 42 is the offset of this entry's LOCAL
  // header from the start of the file. Omitted, every record claimed offset 0,
  // so the archive described every file as starting at the same place. `unzip`
  // rejected the result outright ("overlapped components (possible zip bomb)")
  // and refused to extract anything, while a naive reader that walks the central
  // directory by name saw a perfectly ordinary list of 38 entries.
  central.writeUInt32LE(offset, 42);

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
/** Running offset, which is what each central record has to point back at. */
let offset = 0;

for (const file of files) {
  // Forward slashes regardless of platform: the archive format requires them, and
  // a Windows build would otherwise produce a ZIP neither store can read.
  const name = relative(sourceDir, file).split(sep).join('/');
  const data = readFileSync(file);
  const built = entry(name, data, offset);
  locals.push(built.local);
  centrals.push(built.central);
  uncompressed += built.size;
  // Advanced by the LOCAL header's real length, which includes the name and the
  // payload, not by the payload alone, or every offset after the first is short
  // by the size of the headers before it.
  offset += built.local.length;
}

// The manifest has to be at the archive root. Both stores reject a package where
// it is nested, and the failure reads as "invalid manifest" rather than "wrong
// layout", so it is asserted here rather than discovered at upload.
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
