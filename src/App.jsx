import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import ParticleMorph from './ParticleMorph.jsx'
import { buildShapes } from './shapes.js'

// Harus tepat 3 bentuk: urutan = urutan morphing saat scroll
// hud     = warna teks HUD saat bentuk itu aktif
// palette = [warna A, warna B] (0..1). Untuk 'model', palet ini HANYA dipakai
//           kalau model gagal dimuat; kalau berhasil, warna diambil dari model.
// rotation = [x, y, z] dalam radian, untuk memutar model kalau orientasinya salah
const SHAPES = [
  {
    type: 'text',
    value: 'RAYMOND',
    label: 'IDENTITY',
    hud: '#5fd6ff',
    palette: [[0.23, 0.77, 1.0], [0.41, 0.91, 1.0]],
  },
  {
    type: 'model',
    url: '/models/armor/scene.gltf',
    label: 'ARMOR',
    hud: '#ffb347',
    rotation: [0, 0, 0],
    palette: [[0.95, 0.13, 0.1], [1.0, 0.72, 0.16]],
  },
  {
    type: 'text',
    value: 'PORTFOLIO',
    label: 'PORTFOLIO',
    hud: '#a9a2ff',
    palette: [[0.23, 0.77, 1.0], [0.55, 0.55, 1.0]],
  },
]

const SECTION_TEXTS = [
  'Gerakkan kursor \u00b7 lalu scroll',
  'Teks menyatu',
  'Morphing ke armor',
  'Morphing ke portfolio',
]

// Jumlah partikel = SIDE * SIDE (harus kuadrat sempurna untuk simulasi GPU)
const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
const SIDE = isMobile ? 128 : 256
const PARTICLE_COUNT = SIDE * SIDE

const clamp = (x, a, b) => Math.min(Math.max(x, a), b)
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export default function App() {
  const [shapes, setShapes] = useState(null)
  const [activeIdx, setActiveIdx] = useState(0)

  const formRef = useRef(0)
  const morphRef = useRef(0)
  const lastIdx = useRef(0)

  // Bangun titik + warna tiap bentuk (model dimuat async)
  useEffect(() => {
    let cancelled = false
    buildShapes(SHAPES, PARTICLE_COUNT).then((result) => {
      if (!cancelled) setShapes(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Scroll -> form (0..1) dan morph (0..2)
  useEffect(() => {
    const onScroll = () => {
      const s = window.scrollY / window.innerHeight

      // 0..0.5 : partikel menyatu jadi bentuk pertama
      formRef.current = clamp(s / 0.5, 0, 1)

      // Tiap section: tahan bentuk di paruh pertama, pindah di paruh kedua
      const base = Math.floor(s)
      const morph = base + smoothstep(0.5, 1.0, s - base)
      morphRef.current = Math.min(morph, SHAPES.length - 1)

      const idx = Math.round(morphRef.current)
      if (idx !== lastIdx.current) {
        lastIdx.current = idx
        setActiveIdx(idx)
      }
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const hud = SHAPES[activeIdx].hud
  const hudStyle = { color: hud, transition: 'color 0.6s ease' }
  const usedFallback = shapes && shapes.some((s) => s.fallback)

  return (
    <>
      <div className="canvas-wrap">
        {shapes && (
          <Canvas
            dpr={[1, 2]}
            camera={{ position: [0, 0, 6], fov: 50 }}
            gl={{ antialias: false, powerPreference: 'high-performance' }}
          >
            <color attach="background" args={['#02060d']} />
            <ParticleMorph shapes={shapes} formRef={formRef} morphRef={morphRef} />
            <EffectComposer>
              <Bloom
                intensity={1.1}
                luminanceThreshold={0.8}
                luminanceSmoothing={0.2}
                mipmapBlur
              />
            </EffectComposer>
          </Canvas>
        )}
      </div>

      {!shapes && (
        <div
          className="hud-text"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            zIndex: 2,
          }}
        >
          Menyiapkan partikel...
        </div>
      )}

      <div className="hud-corner tl" style={hudStyle}>
        NANOPARTICLE // MK-50
      </div>
      <div className="hud-corner tr" style={hudStyle}>
        {activeIdx + 1}/{SHAPES.length} &mdash; {SHAPES[activeIdx].label}
      </div>
      <div className="hud-corner" style={{ bottom: 20, right: 24, ...hudStyle }}>
        {PARTICLE_COUNT.toLocaleString()} PARTICLES // GPGPU
      </div>

      {usedFallback && (
        <div className="hud-corner" style={{ bottom: 20, left: 24, color: '#ff6b6b' }}>
          Model gagal dimuat, memakai bentuk cadangan (cek console)
        </div>
      )}

      <div className="scroll-space">
        {SECTION_TEXTS.map((t) => (
          <section className="section" key={t}>
            <p className="hud-text" style={hudStyle}>
              {t}
            </p>
          </section>
        ))}
      </div>
    </>
  )
}