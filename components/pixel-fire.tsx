'use client'

import { useEffect, useRef, type CSSProperties } from 'react'

type RGB = [number, number, number]

interface PixelFireProps {
  /** Hex color for the hot core of the flame. Default '#ff3300' (classic orange). */
  color?: string
  /** Size of each fire pixel in screen px. Larger = chunkier. Default 4. */
  pixelSize?: number
  /** Animation frames per second. Default 30 (authentic retro feel). */
  fps?: number
  /** Optional custom palette of 37 RGB tuples. Overrides `color` if provided. */
  palette?: RGB[]
  className?: string
  style?: CSSProperties
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return [h * 360, s, l]
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h /= 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

function buildPalette(baseColor: string): RGB[] {
  const [h, s] = rgbToHsl(hexToRgb(baseColor))
  const out: RGB[] = []
  for (let i = 0; i < 37; i++) {
    const t = i / 36
    if (t < 0.05) {
      // Embers fading to black
      out.push(hslToRgb(h, s, 0.02 + (t / 0.05) * 0.06))
    } else if (t < 0.85) {
      // Main flame ramp
      const k = (t - 0.05) / 0.8
      out.push(hslToRgb(h, s, 0.1 + k * 0.5))
    } else {
      // White hot tip (desaturate toward white)
      const k = (t - 0.85) / 0.15
      out.push(hslToRgb(h, s * (1 - k), 0.6 + k * 0.4))
    }
  }
  return out
}

export default function PixelFire({
  color = '#ff3300',
  pixelSize = 4,
  fps = 30,
  palette: customPalette,
  className,
  style,
}: PixelFireProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const palette = customPalette ?? buildPalette(color)
    if (palette.length !== 37) {
      console.warn('PixelFire: custom palette should have 37 entries')
    }

    // Flatten palette to a typed array for fast indexing
    const paletteFlat = new Uint8ClampedArray(palette.length * 4)
    palette.forEach((c, i) => {
      paletteFlat[i * 4] = c[0]
      paletteFlat[i * 4 + 1] = c[1]
      paletteFlat[i * 4 + 2] = c[2]
      paletteFlat[i * 4 + 3] = 255
    })

    let cols = 0, rows = 0
    let pixels = new Uint8Array(0)
    let offscreen: HTMLCanvasElement
    let offCtx: CanvasRenderingContext2D
    let imageData: ImageData
    let rafId = 0
    let lastFrame = 0
    const frameInterval = 1000 / fps

    const setup = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      cols = Math.max(1, Math.ceil(rect.width / pixelSize))
      rows = Math.max(1, Math.ceil(rect.height / pixelSize))
      pixels = new Uint8Array(cols * rows)
      // Pin bottom row at max intensity
      for (let x = 0; x < cols; x++) {
        pixels[(rows - 1) * cols + x] = 36
      }
      offscreen = document.createElement('canvas')
      offscreen.width = cols
      offscreen.height = rows
      offCtx = offscreen.getContext('2d')!
      imageData = offCtx.createImageData(cols, rows)
    }

    const step = () => {
      // Walk every cell, propagate from below with random drift + decay
      for (let y = 1; y < rows; y++) {
        const rowStart = y * cols
        for (let x = 0; x < cols; x++) {
          const idx = rowStart + x
          const rand = (Math.random() * 3) | 0
          const dst = idx - cols - (rand - 1)
          if (dst < 0 || dst >= pixels.length) continue
          const decay = Math.random() < 0.5 ? 0 : 1
          const v = pixels[idx] - decay
          pixels[dst] = v < 0 ? 0 : v
        }
      }
    }

    const render = () => {
      const data = imageData.data
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i]
        const j = i * 4
        const k = v * 4
        data[j] = paletteFlat[k]
        data[j + 1] = paletteFlat[k + 1]
        data[j + 2] = paletteFlat[k + 2]
        data[j + 3] = v === 0 ? 0 : 255
      }
      offCtx.putImageData(imageData, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)
    }

    const loop = (t: number) => {
      if (t - lastFrame > frameInterval) {
        step()
        render()
        lastFrame = t
      }
      rafId = requestAnimationFrame(loop)
    }

    setup()
    const onResize = () => setup()
    window.addEventListener('resize', onResize)
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
    }
  }, [color, pixelSize, fps, customPalette])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  )
}