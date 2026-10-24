const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Incremental SHA-256 for files too large to hand to SubtleCrypto in one buffer. */
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    this.total += data.length;
    let i = 0;
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, n), this.bufLen);
      this.bufLen += n;
      i = n;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
    return this;
  }

  digestHex(): string {
    const bits = this.total * 8;
    const padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(padLen, Math.floor(bits / 2 ** 32));
    dv.setUint32(padLen + 4, bits >>> 0);
    this.update(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private block(d: Uint8Array, o: number) {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = o + t * 4;
      w[t] = ((d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, dd, e, f, g, h] = this.h;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (dd + t1) >>> 0;
      dd = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const s = [a, b, c, dd, e, f, g, h];
    for (let i = 0; i < 8; i++) this.h[i] = (this.h[i] + s[i]) >>> 0;
  }
}

export const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: BufferSource): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

/** Git blob object id: sha1("blob <size>\0" + content). */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(header.length + data.length);
  all.set(header, 0);
  all.set(data, header.length);
  return toHex(await crypto.subtle.digest('SHA-1', all));
}

export const STREAM_THRESHOLD = 256 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

export interface HashResult {
  sha256: string;
  gitSha?: string;
}

/** Hashes a Blob/File. SubtleCrypto for normal files; chunked JS SHA-256 above `streamThreshold`. */
export async function hashBlob(
  blob: Blob,
  o: { git: boolean; streamThreshold?: number; onProgress?: (fraction: number) => void } = { git: false },
): Promise<HashResult> {
  if (blob.size <= (o.streamThreshold ?? STREAM_THRESHOLD)) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    o.onProgress?.(1);
    return { sha256, gitSha: o.git ? await gitBlobSha(bytes) : undefined };
  }
  if (o.git) throw new Error('Git SHA is only computed for blob-stored files');
  const h = new Sha256();
  for (let off = 0; off < blob.size; off += CHUNK) {
    h.update(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
    o.onProgress?.(Math.min(1, (off + CHUNK) / blob.size));
  }
  return { sha256: h.digestHex() };
}
