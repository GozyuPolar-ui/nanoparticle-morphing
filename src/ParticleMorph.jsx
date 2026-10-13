import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js'

/* =====================================================================
   SHADER SIMULASI (jalan di GPU, satu texel = satu partikel)
   Catatan: 'resolution', 'texturePosition' dan 'textureVelocity'
   otomatis disediakan oleh GPUComputationRenderer.
   ===================================================================== */

// Posisi: xyz = posisi, w = "form" (0 = debu, 1 = menyatu), diisi dari shader kecepatan
const positionShader = /* glsl */ `
  uniform float uDelta;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);

    pos.xyz += vel.xyz * uDelta;
    pos.w = vel.w;

    gl_FragColor = pos;
  }
`

// Kecepatan: xyz = kecepatan, w = form
const velocityShader = /* glsl */ `
  uniform sampler2D tShape0;   // xyz = bentuk 0, w = angka acak per partikel
  uniform sampler2D tShape1;
  uniform sampler2D tShape2;
  uniform sampler2D tScatter;  // posisi "debu"

  uniform float uTime;
  uniform float uDelta;
  uniform float uForm;         // 0..1 dari scroll
  uniform float uMorph;        // 0..2 antar bentuk
  uniform float uRot;
  uniform vec2  uMouse;
  uniform float uMouseActive;
  uniform float uRadius;       // radius "reveal" kursor
  uniform float uRepelRadius;
  uniform float uRepelStrength;

  vec3 rotY(vec3 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  }

  // Curl dari vector potential (turunan analitik) -> aliran tanpa divergensi
  vec3 curlField(vec3 p, float t) {
    float dFz_dy = 1.2 * cos(p.y * 1.2 - t);
    float dFy_dz = 1.1 * cos(p.z * 1.1 - t * 0.7);
    float dFx_dz = 1.7 * cos(p.z * 1.7 - t * 0.8);
    float dFz_dx = 1.5 * cos(p.x * 1.5 + t * 0.6);
    float dFy_dx = 1.9 * cos(p.x * 1.9 + t * 0.9);
    float dFx_dy = 1.3 * cos(p.y * 1.3 + t);
    return vec3(dFz_dy - dFy_dz, dFx_dz - dFz_dx, dFy_dx - dFx_dy);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;

    vec4 pos = texture2D(texturePosition, uv);
    vec4 vel = texture2D(textureVelocity, uv);

    vec4 s0   = texture2D(tShape0, uv);
    vec3 s1   = texture2D(tShape1, uv).xyz;
    vec3 s2   = texture2D(tShape2, uv).xyz;
    vec3 scat = texture2D(tScatter, uv).xyz;
    float rnd = s0.w;

    // Target: morph antar bentuk dengan stagger per partikel
    float m  = clamp(uMorph, 0.0, 2.0);
    float k1 = smoothstep(rnd * 0.4, 0.6 + rnd * 0.4, clamp(m, 0.0, 1.0));
    float k2 = smoothstep(rnd * 0.4, 0.6 + rnd * 0.4, clamp(m - 1.0, 0.0, 1.0));
    vec3 target = mix(mix(s0.xyz, s1, k1), s2, k2);
    target = rotY(target, uRot);

    // Seberapa menyatu: scroll + reveal kursor
    float d     = distance(target.xy, uMouse);
    float local = (1.0 - smoothstep(0.0, uRadius, d)) * uMouseActive;
    float raw   = max(uForm, local);
    float form  = smoothstep(rnd * 0.35, 0.65 + rnd * 0.35, raw);

    vec3 desired = mix(scat, target, form);

    // Pegas + redaman (lebih kaku saat sudah menyatu)
    float stiff = mix(0.8, 20.0, form) * (0.8 + 0.4 * rnd);
    float damp  = mix(1.5, 6.5, form);
    vec3 acc = (desired - pos.xyz) * stiff;

    // Aliran curl: kuat saat debu, tipis saat menyatu
    acc += curlField(pos.xyz * 0.45, uTime * 0.35) * mix(0.9, 0.3, form);

    // Kursor: dorong keluar + pusaran (aktif setelah bentuk menyatu lewat scroll)
    vec2  diff = pos.xy - uMouse;
    float dist = length(diff);
    vec2  dir  = diff / max(dist, 0.0001);
    float fall = 1.0 - smoothstep(0.0, uRepelRadius, dist);
    float f2   = fall * fall * uMouseActive * uForm;

    acc.xy += dir * f2 * uRepelStrength * 30.0 * (0.6 + 0.8 * rnd);
    acc.xy += vec2(-dir.y, dir.x) * f2 * uRepelStrength * 12.0;
    acc.z  += (rnd - 0.5) * 2.0 * f2 * uRepelStrength * 20.0;

    // Integrasi (redaman tidak bergantung frame-rate)
    vel.xyz += acc * uDelta;
    vel.xyz *= exp(-damp * uDelta);
    vel.w = form;

    gl_FragColor = vel;
  }
`

/* =====================================================================
   SHADER RENDER (menggambar titik dari texture posisi)
   ===================================================================== */

const vertexShader = /* glsl */ `
  uniform sampler2D tPosition;
  uniform float uMorph;
  uniform float uSize;
  uniform float uPixelRatio;

  attribute vec2  aRef;      // koordinat texel partikel ini
  attribute float aRandom;
  attribute vec3  aColor0;
  attribute vec3  aColor1;
  attribute vec3  aColor2;

  varying float vForm;
  varying vec3  vColor;

  void main() {
    vec4 data = texture2D(tPosition, aRef);
    vec3 p = data.xyz;
    vForm = data.w;

    // Warna ikut ter-morph dengan faktor yang sama dengan target
    float m  = clamp(uMorph, 0.0, 2.0);
    float k1 = smoothstep(aRandom * 0.4, 0.6 + aRandom * 0.4, clamp(m, 0.0, 1.0));
    float k2 = smoothstep(aRandom * 0.4, 0.6 + aRandom * 0.4, clamp(m - 1.0, 0.0, 1.0));
    vColor = mix(mix(aColor0, aColor1, k1), aColor2, k2);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * mix(0.7, 1.4, vForm) * (1.0 / -mv.z);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uBoost;
  varying float vForm;
  varying vec3  vColor;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;

    float alpha = smoothstep(0.5, 0.0, d);

    vec3 c = vColor * uBoost;
    vec3 color = mix(c * 0.2, c, vForm);

    gl_FragColor = vec4(color, alpha * mix(0.25, 1.0, vForm));
  }
`

/* =====================================================================
   Pembangun simulasi
   ===================================================================== */

function createSim(gl, shapes, p) {
  const count = shapes[0].positions.length / 3
  const side = Math.round(Math.sqrt(count))
  if (side * side !== count) {
    throw new Error(
      `Jumlah partikel (${count}) harus kuadrat sempurna, mis. 128*128 atau 256*256.`
    )
  }

  const random = new Float32Array(count)
  const scatter = new Float32Array(count * 3)
  const aRef = new Float32Array(count * 2)

  for (let i = 0; i < count; i++) {
    random[i] = Math.random()

    const r = 3 + Math.random() * 5
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    scatter[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta) * 1.4
    scatter[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.8
    scatter[i * 3 + 2] = r * Math.cos(phi) * 0.6

    aRef[i * 2 + 0] = ((i % side) + 0.5) / side
    aRef[i * 2 + 1] = (Math.floor(i / side) + 0.5) / side
  }

  // Texture float RGBA berisi data per partikel
  const makeTex = (fill) => {
    const data = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) fill(data, i)
    const t = new THREE.DataTexture(data, side, side, THREE.RGBAFormat, THREE.FloatType)
    t.minFilter = THREE.NearestFilter
    t.magFilter = THREE.NearestFilter
    t.needsUpdate = true
    return t
  }

  const shapeTex = shapes.map((s, idx) =>
    makeTex((d, i) => {
      d[i * 4 + 0] = s.positions[i * 3 + 0]
      d[i * 4 + 1] = s.positions[i * 3 + 1]
      d[i * 4 + 2] = s.positions[i * 3 + 2]
      d[i * 4 + 3] = idx === 0 ? random[i] : 0
    })
  )
  const scatterTex = makeTex((d, i) => {
    d[i * 4 + 0] = scatter[i * 3 + 0]
    d[i * 4 + 1] = scatter[i * 3 + 1]
    d[i * 4 + 2] = scatter[i * 3 + 2]
    d[i * 4 + 3] = 0
  })

  // Geometry untuk menggambar: 'position' hanya dummy (posisi asli dari texture)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aRef', new THREE.BufferAttribute(aRef, 2))
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(random, 1))
  geometry.setAttribute('aColor0', new THREE.BufferAttribute(shapes[0].colors, 3))
  geometry.setAttribute('aColor1', new THREE.BufferAttribute(shapes[1].colors, 3))
  geometry.setAttribute('aColor2', new THREE.BufferAttribute(shapes[2].colors, 3))

  // GPGPU
  const gpu = new GPUComputationRenderer(side, side, gl)
  const posInit = gpu.createTexture()
  const velInit = gpu.createTexture()

  const pd = posInit.image.data
  for (let i = 0; i < count; i++) {
    pd[i * 4 + 0] = scatter[i * 3 + 0]
    pd[i * 4 + 1] = scatter[i * 3 + 1]
    pd[i * 4 + 2] = scatter[i * 3 + 2]
    pd[i * 4 + 3] = 0
  }

  const posVar = gpu.addVariable('texturePosition', positionShader, posInit)
  const velVar = gpu.addVariable('textureVelocity', velocityShader, velInit)
  gpu.setVariableDependencies(posVar, [posVar, velVar])
  gpu.setVariableDependencies(velVar, [posVar, velVar])

  posVar.material.uniforms.uDelta = { value: 0.016 }

  const vu = velVar.material.uniforms
  vu.tShape0 = { value: shapeTex[0] }
  vu.tShape1 = { value: shapeTex[1] }
  vu.tShape2 = { value: shapeTex[2] }
  vu.tScatter = { value: scatterTex }
  vu.uTime = { value: 0 }
  vu.uDelta = { value: 0.016 }
  vu.uForm = { value: 0 }
  vu.uMorph = { value: 0 }
  vu.uRot = { value: 0 }
  vu.uMouse = { value: new THREE.Vector2(99, 99) }
  vu.uMouseActive = { value: 0 }
  vu.uRadius = { value: p.radius }
  vu.uRepelRadius = { value: p.repelRadius }
  vu.uRepelStrength = { value: p.repelStrength }

  const err = gpu.init()
  if (err !== null) console.error('GPUComputationRenderer:', err)

  const uniforms = {
    tPosition: { value: gpu.getCurrentRenderTarget(posVar).texture },
    uMorph: { value: 0 },
    uSize: { value: p.size },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uBoost: { value: p.colorBoost },
  }

  const textures = [...shapeTex, scatterTex, posInit, velInit]

  return {
    gpu,
    posVar,
    velVar,
    geometry,
    uniforms,
    dispose() {
      geometry.dispose()
      textures.forEach((t) => t.dispose())
      if (gpu.dispose) gpu.dispose()
    },
  }
}

/* =====================================================================
   Komponen
   ===================================================================== */

export default function ParticleMorph({
  shapes,          // [{ positions, colors }, x3]
  formRef,         // ref angka 0..1
  morphRef,        // ref angka 0..2
  size = 14,
  radius = 2.2,
  repelRadius = 1.4,
  repelStrength = 0.5,
  colorBoost = 2.2,
}) {
  const gl = useThree((s) => s.gl)
  const [sim, setSim] = useState(null)

  // Mouse dilacak lewat window, karena layer .scroll-space menutupi canvas
  const mouse = useRef({ x: 0, y: 0, active: false })
  // Nilai yang sudah dihaluskan
  const smooth = useRef({
    form: 0,
    morph: 0,
    active: 0,
    mouse: new THREE.Vector2(99, 99),
  })

  useEffect(() => {
    const m = mouse.current
    const onMove = (e) => {
      m.x = (e.clientX / window.innerWidth) * 2 - 1
      m.y = -(e.clientY / window.innerHeight) * 2 + 1
      m.active = true
    }
    const onLeave = () => {
      m.active = false
    }
    const onUp = (e) => {
      if (e.pointerType === 'touch') m.active = false
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('blur', onLeave)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('blur', onLeave)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // Buat simulasi (dibuat di effect supaya aman dengan StrictMode)
  useEffect(() => {
    const s = createSim(gl, shapes, { size, radius, repelRadius, repelStrength, colorBoost })
    setSim(s)
    return () => {
      s.dispose()
    }
  }, [gl, shapes, size, radius, repelRadius, repelStrength, colorBoost])

  useFrame((state, delta) => {
    if (!sim) return

    const dt = Math.min(delta, 1 / 30) // jaga stabilitas simulasi
    const t = state.clock.elapsedTime
    const m = mouse.current
    const s = smooth.current

    const mx = (m.x * state.viewport.width) / 2
    const my = (m.y * state.viewport.height) / 2

    // Saat kursor baru masuk, langsung "lompat" ke posisinya
    if (m.active && s.active < 0.02) s.mouse.set(mx, my)
    if (m.active) {
      s.mouse.x = THREE.MathUtils.damp(s.mouse.x, mx, 6, delta)
      s.mouse.y = THREE.MathUtils.damp(s.mouse.y, my, 6, delta)
    }
    s.active = THREE.MathUtils.damp(s.active, m.active ? 1 : 0, 6, delta)

    s.form = THREE.MathUtils.damp(s.form, formRef.current, 3, delta)
    s.morph = THREE.MathUtils.damp(s.morph, morphRef.current, 2.5, delta)

    // Goyang hanya saat berada di bentuk tengah (model 3D)
    const w = Math.max(0, 1 - Math.abs(s.morph - 1))
    const rot = Math.sin(t * 0.5) * 0.9 * w

    const vu = sim.velVar.material.uniforms
    vu.uTime.value = t
    vu.uDelta.value = dt
    vu.uForm.value = s.form
    vu.uMorph.value = s.morph
    vu.uRot.value = rot
    vu.uMouse.value.copy(s.mouse)
    vu.uMouseActive.value = s.active
    sim.posVar.material.uniforms.uDelta.value = dt

    sim.gpu.compute()

    sim.uniforms.tPosition.value = sim.gpu.getCurrentRenderTarget(sim.posVar).texture
    sim.uniforms.uMorph.value = s.morph
  })

  if (!sim) return null

  return (
    <points geometry={sim.geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={sim.uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}