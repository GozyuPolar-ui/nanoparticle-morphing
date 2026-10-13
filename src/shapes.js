import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'

/* ---------- Palet warna (0..1) ---------- */

const DEFAULT_PALETTE = [
  [0.23, 0.77, 1.0],
  [0.41, 0.91, 1.0],
]

// Warna acak A/B per partikel, dengan sedikit variasi kecerahan
function paletteColors(count, palette = DEFAULT_PALETTE) {
  const [A, B] = palette
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const c = Math.random() < 0.4 ? B : A
    const v = 0.9 + Math.random() * 0.2
    out[i * 3 + 0] = c[0] * v
    out[i * 3 + 1] = c[1] * v
    out[i * 3 + 2] = c[2] * v
  }
  return out
}

/* ---------- Teks -> titik ---------- */

export function textToPoints(text, count, worldWidth = 8) {
  const W = 1400
  const H = 360
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  let fontSize = 260
  do {
    ctx.font = `900 ${fontSize}px "Arial Black", Arial, sans-serif`
    fontSize -= 10
  } while (ctx.measureText(text).width > W * 0.92 && fontSize > 40)

  ctx.fillText(text, W / 2, H / 2)

  const { data } = ctx.getImageData(0, 0, W, H)
  const pixels = []
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (data[(y * W + x) * 4 + 3] > 128) pixels.push([x, y])
    }
  }

  for (let i = pixels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pixels[i], pixels[j]] = [pixels[j], pixels[i]]
  }

  const scale = worldWidth / W
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const [px, py] = pixels[i % pixels.length]
    const jitter = i >= pixels.length ? 0.01 : 0
    out[i * 3 + 0] = (px - W / 2) * scale + (Math.random() - 0.5) * jitter
    out[i * 3 + 1] = -(py - H / 2) * scale + (Math.random() - 0.5) * jitter
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.08
  }
  return out
}

/* ---------- Geometry biasa -> titik (dipakai untuk bentuk cadangan) ---------- */

function geometryToPoints(geometry, count, maxSize = 4.2) {
  const geo = geometry.clone()
  geo.computeBoundingBox()

  const center = geo.boundingBox.getCenter(new THREE.Vector3())
  const size = geo.boundingBox.getSize(new THREE.Vector3())
  const scale = maxSize / Math.max(size.x, size.y, size.z)

  geo.translate(-center.x, -center.y, -center.z)
  geo.scale(scale, scale, scale)

  const sampler = new MeshSurfaceSampler(new THREE.Mesh(geo)).build()
  const v = new THREE.Vector3()
  const out = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    sampler.sample(v)
    out[i * 3 + 0] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  return out
}

function fallbackPoints(count) {
  return geometryToPoints(new THREE.TorusKnotGeometry(1, 0.35, 220, 36), count)
}

/* ---------- Baca tekstur & material model ---------- */

const TEX_MAX = 1024

function readTexture(tex) {
  try {
    const img = tex && tex.image
    if (!img || !img.width || !img.height) return null

    const k = Math.min(1, TEX_MAX / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * k))
    const h = Math.max(1, Math.round(img.height * k))

    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)

    return { data: ctx.getImageData(0, 0, w, h).data, w, h, flipY: !!tex.flipY }
  } catch (err) {
    console.warn('Tekstur tidak bisa dibaca, pakai warna material saja.', err)
    return null
  }
}

function materialInfo(mat, matCache, texCache) {
  if (matCache.has(mat)) return matCache.get(mat)

  const rgb = { r: 1, g: 1, b: 1 }
  if (mat && mat.color) mat.color.getRGB(rgb, THREE.SRGBColorSpace)

  let tex = null
  if (mat && mat.map) {
    if (!texCache.has(mat.map)) texCache.set(mat.map, readTexture(mat.map))
    tex = texCache.get(mat.map)
  }

  const info = { r: rgb.r, g: rgb.g, b: rgb.b, tex }
  matCache.set(mat, info)
  return info
}

/* ---------- Perbaikan warna supaya "nendang" (terutama emas) ----------
   1) naikkan kecerahan sampai penuh (hue tetap)
   2) naikkan saturasi
   3) hue emas (28..65 derajat) dapat boost kecerahan ekstra -> kena bloom */

function enhanceColor(r, g, b, saturation, goldBoost, floor) {
  const mx0 = Math.max(r, g, b)

  // Hampir hitam -> abu gelap (tidak diterangkan, biar bagian gelap tetap gelap)
  if (mx0 < 0.06) return [floor, floor, floor]

  // 1) kecerahan penuh
  const k = Math.min(1 / mx0, 8)
  r *= k
  g *= k
  b *= k

  // 2) saturasi: dorong menjauh dari abu-abu
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  r = Math.min(Math.max(l + (r - l) * saturation, 0), 1)
  g = Math.min(Math.max(l + (g - l) * saturation, 0), 1)
  b = Math.min(Math.max(l + (b - l) * saturation, 0), 1)

  // 3) boost hue emas
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn

  if (d > 0.0001 && d / mx > 0.35) {
    let h
    if (mx === r) h = ((g - b) / d + 6) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60

    if (h >= 28 && h <= 65) {
      r *= goldBoost
      g *= goldBoost
      b *= goldBoost
    }
  }

  return [Math.max(r, floor), Math.max(g, floor), Math.max(b, floor)]
}

/* ---------- File GLB/GLTF -> titik + warna asli model ---------- */

async function modelToPoints(url, count, opts = {}) {
  const {
    rotation = [0, 0, 0],
    maxSize = 4.2,
    saturation = 1.35,
    goldBoost = 1.6,
    floor = 0.12,
  } = opts

  const gltf = await new GLTFLoader().loadAsync(url)
  gltf.scene.updateMatrixWorld(true)

  const rotM = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation))
  const matCache = new Map()
  const texCache = new Map()
  const box = new THREE.Box3()
  const parts = []

  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return

    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()
    g.applyMatrix4(rotM.clone().multiply(o.matrixWorld))
    g.computeBoundingBox()
    box.union(g.boundingBox)

    const posAttr = g.attributes.position
    const uvAttr = g.attributes.uv
    const n = posAttr.count
    const triCount = Math.floor(n / 3)

    const P = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      P[i * 3 + 0] = posAttr.getX(i)
      P[i * 3 + 1] = posAttr.getY(i)
      P[i * 3 + 2] = posAttr.getZ(i)
    }

    let uv = null
    if (uvAttr) {
      uv = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) {
        uv[i * 2 + 0] = uvAttr.getX(i)
        uv[i * 2 + 1] = uvAttr.getY(i)
      }
    }

    // Material per segitiga (mendukung multi-material)
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const infos = mats.map((m) => materialInfo(m, matCache, texCache))
    const triMat = new Uint16Array(triCount)
    if (Array.isArray(o.material) && g.groups.length) {
      for (const gr of g.groups) {
        const t0 = Math.floor(gr.start / 3)
        const t1 = Math.min(triCount, Math.floor((gr.start + gr.count) / 3))
        for (let t = t0; t < t1; t++) triMat[t] = gr.materialIndex
      }
    }

    // Luas kumulatif tiap segitiga (supaya sampling merata di permukaan)
    const cum = new Float64Array(triCount)
    let total = 0
    for (let t = 0; t < triCount; t++) {
      const i = t * 9
      const ax = P[i], ay = P[i + 1], az = P[i + 2]
      const e1x = P[i + 3] - ax, e1y = P[i + 4] - ay, e1z = P[i + 5] - az
      const e2x = P[i + 6] - ax, e2y = P[i + 7] - ay, e2z = P[i + 8] - az
      const cx = e1y * e2z - e1z * e2y
      const cy = e1z * e2x - e1x * e2z
      const cz = e1x * e2y - e1y * e2x
      total += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
      cum[t] = total
    }

    if (total > 0) parts.push({ P, uv, cum, total, triMat, infos, triCount })
  })

  if (!parts.length) throw new Error('Model tidak punya mesh')

  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const scale = maxSize / Math.max(size.x, size.y, size.z)

  const partCum = []
  let grand = 0
  for (const p of parts) {
    grand += p.total
    partCum.push(grand)
  }

  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    // Pilih mesh, lalu segitiga (binary search), berdasarkan luas
    const r = Math.random() * grand
    let pi = 0
    while (pi < parts.length - 1 && r > partCum[pi]) pi++
    const part = parts[pi]
    const local = r - (pi > 0 ? partCum[pi - 1] : 0)

    let lo = 0
    let hi = part.triCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (part.cum[mid] >= local) hi = mid
      else lo = mid + 1
    }
    const t = lo

    // Titik acak di dalam segitiga (koordinat barycentric)
    const s = Math.sqrt(Math.random())
    const r2 = Math.random()
    const a = 1 - s
    const b = s * (1 - r2)
    const c = s * r2

    const P = part.P
    const i0 = t * 9
    const x = a * P[i0] + b * P[i0 + 3] + c * P[i0 + 6]
    const y = a * P[i0 + 1] + b * P[i0 + 4] + c * P[i0 + 7]
    const z = a * P[i0 + 2] + b * P[i0 + 5] + c * P[i0 + 8]

    positions[i * 3 + 0] = (x - center.x) * scale
    positions[i * 3 + 1] = (y - center.y) * scale
    positions[i * 3 + 2] = (z - center.z) * scale

    // Warna: warna material x tekstur di titik itu
    const info = part.infos[Math.min(part.triMat[t], part.infos.length - 1)]
    let cr = info.r
    let cg = info.g
    let cb = info.b

    if (info.tex && part.uv) {
      const j = t * 6
      const uv = part.uv
      let u = a * uv[j] + b * uv[j + 2] + c * uv[j + 4]
      let v = a * uv[j + 1] + b * uv[j + 3] + c * uv[j + 5]
      u -= Math.floor(u)
      v -= Math.floor(v)

      const tex = info.tex
      const vv = tex.flipY ? 1 - v : v
      const px = Math.min(tex.w - 1, (u * tex.w) | 0)
      const py = Math.min(tex.h - 1, (vv * tex.h) | 0)
      const k = (py * tex.w + px) * 4
      cr *= tex.data[k] / 255
      cg *= tex.data[k + 1] / 255
      cb *= tex.data[k + 2] / 255
    }

    const [er, eg, eb] = enhanceColor(cr, cg, cb, saturation, goldBoost, floor)
    colors[i * 3 + 0] = er
    colors[i * 3 + 1] = eg
    colors[i * 3 + 2] = eb
  }

  return { positions, colors }
}

/* ---------- Bangun semua bentuk dari config ---------- */
// Hasil: [{ positions, colors, fallback }, ...]

export async function buildShapes(config, count) {
  const result = []

  for (const item of config) {
    if (item.type === 'text') {
      result.push({
        positions: textToPoints(item.value, count),
        colors: paletteColors(count, item.palette),
        fallback: false,
      })
    } else if (item.type === 'model') {
      try {
        const r = await modelToPoints(item.url, count, item)
        result.push({ ...r, fallback: false })
      } catch (err) {
        console.warn(`Model "${item.url}" gagal dimuat, pakai bentuk cadangan.`, err)
        result.push({
          positions: fallbackPoints(count),
          colors: paletteColors(count, item.palette),
          fallback: true,
        })
      }
    }
  }
  return result
}