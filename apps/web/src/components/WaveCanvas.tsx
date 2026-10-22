import { useEffect, useRef } from 'react';
import { controller } from '../store/app.ts';
import { useReducedMotion } from './common.tsx';

/**
 * Audio-reactive backdrop for "Моя волна": layered lines driven by the real
 * output spectrum (AnalyserNode after the mixer). Static when reduced motion
 * is requested or nothing plays.
 */
export function WaveCanvas({ className = '', intensity = 1 }: { className?: string; intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext('2d')!;
    let raf = 0;
    let t = 0;
    const bins = new Uint8Array(1024);
    const levels = [0, 0, 0];
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      const an = controller.analyser;
      const playing = controller.state.status === 'playing';
      if (an && playing) {
        an.getByteFrequencyData(bins);
        const band = (a: number, b: number) => {
          let s = 0;
          for (let i = a; i < b; i++) s += bins[i];
          return s / (b - a) / 255;
        };
        const target = [band(1, 8), band(8, 90), band(90, 400)];
        for (let i = 0; i < 3; i++) levels[i] += (target[i] - levels[i]) * 0.18;
      } else {
        for (let i = 0; i < 3; i++) levels[i] *= 0.95;
      }
      const css = getComputedStyle(document.documentElement);
      const art = css.getPropertyValue('--art').trim() || '28 74 52';
      g.clearRect(0, 0, W, H);
      const lines = 9;
      for (let k = 0; k < lines; k++) {
        const f = k / (lines - 1);
        const amp = H * (0.04 + 0.22 * (levels[0] * (1 - f) + levels[1] * f) * intensity + 0.015 * Math.sin(t * 0.3 + k));
        const yBase = H * (0.42 + f * 0.5);
        g.beginPath();
        for (let x = 0; x <= W; x += 6) {
          const u = x / W;
          const y =
            yBase +
            Math.sin(u * (3 + f * 2) * Math.PI + t * (0.6 + f * 0.4) + k) * amp +
            Math.sin(u * 11 * Math.PI - t * 1.3 + k * 2) * amp * 0.18 * (0.3 + levels[2] * 2);
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        const alpha = 0.1 + 0.32 * (1 - f) * (0.5 + levels[1]);
        g.strokeStyle = k % 3 === 0 ? `rgba(245, 200, 110, ${alpha * 0.85})` : `rgb(${art} / ${alpha + 0.12})`;
        g.lineWidth = (1 + (1 - f) * 2.2) * (devicePixelRatio || 1);
        g.stroke();
      }
      if (!reduced) {
        if (playing) t += 0.016 * (0.6 + levels[0] * 2.4);
        raf = requestAnimationFrame(draw);
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduced, intensity]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
