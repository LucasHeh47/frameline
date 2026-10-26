// Color looks (.cube LUT files, as made by DaVinci Resolve, Premiere and most LUT packs). A 3D LUT
// maps every color to a new one; the renderer looks colors up in it on the GPU.

export interface Lut3D {
  title: string;
  size: number;
  /** size³ RGB triples (0–1), red changing fastest. */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export function parseCube(text: string): Lut3D {
  let title = '';
  let size = 0;
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    const upper = key.toUpperCase();
    if (upper === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (upper === 'LUT_3D_SIZE') size = parseInt(rest[0], 10);
    else if (upper === 'LUT_1D_SIZE') throw new Error('1D LUTs aren’t supported; use a 3D .cube LUT.');
    else if (upper === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number) as [number, number, number];
    else if (upper === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number) as [number, number, number];
    else if (/^[-+.\d]/.test(key)) {
      const nums = [key, ...rest].slice(0, 3).map(Number);
      if (nums.length === 3 && nums.every(Number.isFinite)) values.push(...nums);
    }
  }
  if (!size || size < 2 || size > 128) throw new Error('This .cube file has no LUT_3D_SIZE.');
  if (values.length !== size * size * size * 3) throw new Error(`This .cube file should have ${size ** 3} colors but has ${values.length / 3}.`);
  return { title, size, data: Float32Array.from(values), domainMin: min, domainMax: max };
}

/** Looks one color up (trilinear), for tests and the CPU fallback. */
export function applyLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1;
  const norm = (v: number, i: number) => Math.max(0, Math.min(1, (v - lut.domainMin[i]) / (lut.domainMax[i] - lut.domainMin[i] || 1))) * n;
  const x = norm(r, 0);
  const y = norm(g, 1);
  const z = norm(b, 2);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(n, x0 + 1);
  const y1 = Math.min(n, y0 + 1);
  const z1 = Math.min(n, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const at = (i: number, j: number, k: number, c: number) => lut.data[((k * lut.size + j) * lut.size + i) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}
