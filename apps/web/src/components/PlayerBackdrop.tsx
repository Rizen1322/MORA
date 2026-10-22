import { useEffect, useRef } from 'react';
import { controller, useApp } from '../store/app.ts';
import { startBackdropCanvas } from '../lib/backdrop-canvas.ts';
import { useReducedMotion } from './common.tsx';
import { AudibleMotion, audibleDelay } from '../lib/audible-motion.ts';

/**
 * Full-player backdrop: the current cover, shrunk to a few pixels so only its
 * colours remain, flowing like liquid under the content (WebGL shader). The real
 * output spectrum drives it: bass breathes the zoom and brightness, onsets
 * flash, mids stir the flow. During an AutoMix blend it melts from A's cover
 * into B's at the blend's own pace; a plain skip crossfades in about a second.
 * Writes `--beat` (0..1) on the parent for the CSS cover pulse. Lazy three.js,
 * 30 fps, low internal resolution, stops while hidden; one still frame with
 * reduced motion. Without WebGL the CSS gradient of the player stays.
 */
export function PlayerBackdrop({ cover, next = null, k = 0 }: { cover: string | null; next?: string | null; k?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const props = useRef({ cover, next, k });
  props.current = { cover, next, k };
  const reduced = useReducedMotion();
  const graphics=useApp(s=>s.settings?.ui.graphics??'auto');
  useEffect(() => {
    const el = host.current;
    const player = el?.parentElement;
    if (!el || !player) return;
    let disposed = false;
    let cleanup = () => {};
    let fallbackCleanup:(()=>void)|null=null;
    const useFallback=()=>{if(!disposed&&!fallbackCleanup)fallbackCleanup=startBackdropCanvas(el,player,reduced);};
    if(graphics==='canvas'){useFallback();return ()=>{disposed=true;fallbackCleanup?.();};}
    void import('three').then((T) => {
      if (disposed) return;
      let renderer: InstanceType<typeof T.WebGLRenderer>;
      try { renderer = new T.WebGLRenderer({ alpha: false, antialias: false, powerPreference: 'low-power' }); }
      catch { useFallback();return; }
      renderer.domElement.className='backdrop-webgl-canvas';
      renderer.setPixelRatio(0.5); // the image is soft by design; few pixels are enough
      el.appendChild(renderer.domElement);

      // Covers become 24×24 textures: stretched with linear filtering they are pure colour fields.
      const textures = new Map<string, InstanceType<typeof T.Texture>>();
      const fallback = () => {
        const art = getComputedStyle(document.documentElement).getPropertyValue('--art').trim() || '28 74 52';
        // Same size as a loaded cover: three.js allocates texture storage once.
        const c = Object.assign(document.createElement('canvas'), { width: 24, height: 24 });
        const g = c.getContext('2d')!;
        g.fillStyle = `rgb(${art})`; g.fillRect(0, 0, 24, 24);
        g.fillStyle = 'rgb(18 92 62)'; g.fillRect(12, 0, 12, 12); g.fillRect(0, 12, 12, 12);
        return c;
      };
      const texture = (url: string | null) => {
        const key = url ?? '';
        let t = textures.get(key);
        if (t) return t;
        const canvas = fallback();
        t = new T.CanvasTexture(canvas);
        t.wrapS = t.wrapT = T.MirroredRepeatWrapping;
        t.colorSpace = T.SRGBColorSpace;
        textures.set(key, t);
        if (url) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (disposed || textures.get(key) !== t) return;
            const small = Object.assign(document.createElement('canvas'), { width: 24, height: 24 });
            const g = small.getContext('2d')!;
            g.drawImage(img, 0, 0, 24, 24);
            // Auto-exposure: dark covers keep their hues instead of turning the stage black.
            const d = g.getImageData(0, 0, 24, 24);
            const lum = (i: number) => (0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]) / 255;
            const ls: number[] = [];
            for (let i = 0; i < d.data.length; i += 4) ls.push(lum(i));
            ls.sort((x, y) => x - y);
            const gain = Math.min(4, Math.max(1, 0.5 / Math.max(0.02, ls[Math.floor(ls.length * 0.9)])));
            for (let i = 0; i < d.data.length; i += 4) {
              const l = lum(i) * 255;
              for (let ch = 0; ch < 3; ch++) d.data[i + ch] = Math.max(0, Math.min(255, (l + (d.data[i + ch] - l) * 1.4) * gain));
            }
            g.putImageData(d, 0, 0);
            t!.image = small;
            t!.needsUpdate = true;
          };
          img.src = url;
        }
        return t;
      };

      const material = new T.ShaderMaterial({
        uniforms: {
          texA: { value: texture(props.current.cover) }, texB: { value: texture(props.current.cover) }, fade: { value: 0 },
          time: { value: Math.random() * 50 }, bass: { value: 0 }, mid: { value: 0 }, kick: { value: 0 }, aspect: { value: 1 }, tint: { value: new T.Color(0.11, 0.29, 0.2) },
        },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `precision highp float;
          uniform sampler2D texA; uniform sampler2D texB; uniform float fade; uniform float time;
          uniform float bass; uniform float mid; uniform float kick; uniform float aspect; uniform vec3 tint;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
          }
          vec3 cover(vec2 q) { return mix(texture2D(texA, q).rgb, texture2D(texB, q).rgb, fade); }
          void main() {
            vec2 p = (vUv - .5) * vec2(aspect, 1.0);
            // Two-step domain warp: slow liquid flow, stirred harder by the mids.
            vec2 w = vec2(noise(p * 1.3 + time * .06), noise(p * 1.3 - time * .05 + 7.3));
            vec2 w2 = vec2(noise(p * 2.2 + w * 1.8 + time * .09), noise(p * 2.0 - w * 1.6 - time * .08 + 3.1));
            float zoom = 1.25 - bass * .14 - kick * .08;
            float a = time * .025;
            vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p + (w2 - .5) * (.7 + mid * .5)) / zoom;
            vec3 c = cover(q * .55 + .5);
            vec3 c2 = cover(q.yx * .8 + .5 + (w - .5) * .3);
            c = mix(c, c2, .4);
            float l = dot(c, vec3(.299, .587, .114));
            c = mix(vec3(l), c, 1.3);                     // keep the colours rich
            // Dark covers still get light: a drifting mint/art glow that pumps with the bass.
            float glow = noise(p * 1.1 - time * .07 + 11.0);
            c += mix(vec3(.12, .42, .29), tint, .5) * (.05 + glow * .1 + bass * .22 + kick * .3);
            c *= .78 + bass * .3 + kick * .4;
            // Keep bright sleeves below the luminance of foreground controls.
            c = clamp(c, vec3(0.0), vec3(.38));
            c *= 1.0 - smoothstep(.1, 1.45, length(p * vec2(.75, 1.0)));
            gl_FragColor = vec4(c, 1.0);
          }`,
      });
      const scene = new T.Scene();
      const geometry = new T.PlaneGeometry(2, 2);
      scene.add(new T.Mesh(geometry, material));
      const camera = new T.Camera();

      const bins = new Float32Array(1024), waveform = new Float32Array(2048);
      const lv = new AudibleMotion();
      const view = { a: props.current.cover, b: null as string | null, f: 0 };
      let raf = 0, last = 0, lastBeat = -1, visible = true, tintWait = 0;

      const frame = (dt: number) => {
        const st = controller.state;
        const an = controller.analyser;
        if (an && st.status === 'playing') {
          an.getFloatFrequencyData(bins); an.getFloatTimeDomainData(waveform);
          const now = performance.now();
          lv.update(bins, waveform, an.context.sampleRate, an.fftSize, dt, now / 1000, audibleDelay(an.context, now));
        } else lv.update(null, null, 48000, 2048, dt, performance.now() / 1000, 0);
        // Cover flow: follow an AutoMix blend exactly, otherwise crossfade on change.
        const { cover: cur, next: nxt, k } = props.current;
        if (nxt && nxt !== cur) { view.a = cur; view.b = nxt; view.f = Math.min(1, Math.max(0, k)); }
        else if (view.b === cur && view.f > .98) { view.a = cur; view.b = null; view.f = 0; }
        else if (view.a !== cur) { if (view.b !== cur) { view.b = cur; view.f = 0; } view.f = Math.min(1, view.f + dt / 1.1); if (view.f >= 1) { view.a = cur; view.b = null; view.f = 0; } }
        const u = material.uniforms;
        tintWait -= dt;
        if (tintWait <= 0) {
          const art = getComputedStyle(document.documentElement).getPropertyValue('--art').trim().split(' ').map(Number);
          if (art.length === 3 && art.every(Number.isFinite)) u.tint.value.setRGB(art[0] / 255, art[1] / 255, art[2] / 255);
          tintWait = .5;
        }
        u.texA.value = texture(view.a);
        u.texB.value = texture(view.b ?? view.a);
        u.fade.value = view.b ? view.f : 0;
        u.time.value += dt * .7;
        u.bass.value = Math.min(1, lv.bass * 1.4); u.mid.value = lv.mid; u.kick.value = lv.kick;
        const beat = Math.round(Math.min(1, lv.kick * .8 + lv.level * .25) * 100) / 100;
        if (textures.size > 6) for (const [key, tex] of textures) {
          if (tex !== u.texA.value && tex !== u.texB.value) { textures.delete(key); tex.dispose(); }
          if (textures.size <= 6) break;
        }
        if (beat !== lastBeat) { player.style.setProperty('--beat', String(beat)); lastBeat = beat; }
        renderer.render(scene, camera);
      };
      const loop = (now: number) => {
        raf = 0;
        if (disposed || fallbackCleanup || !visible || document.hidden) return;
        const fps = controller.state.status === 'playing' ? 30 : 8;
        if (last && now - last < 1000 / fps - 2) { raf = requestAnimationFrame(loop); return; }
        const dt = last ? Math.min((now - last) / 1000, .1) : 1 / 30;
        last = now;
        frame(dt);
        raf = requestAnimationFrame(loop);
      };
      const resume = () => { if (!raf && !fallbackCleanup && visible && !document.hidden && !reduced) { last = 0; raf = requestAnimationFrame(loop); } };
      const lost=(event:Event)=>{event.preventDefault();cancelAnimationFrame(raf);raf=0;useFallback();};
      const restored=()=>{fallbackCleanup?.();fallbackCleanup=null;resize();};
      renderer.debug.onShaderError=()=>{cancelAnimationFrame(raf);raf=0;useFallback();};
      const resize = () => {
        const { width, height } = el.getBoundingClientRect();
        renderer.setSize(Math.max(1, width), Math.max(1, height));
        material.uniforms.aspect.value = width / Math.max(1, height);
        if (reduced) frame(0); else resume();
      };
      const ro = new ResizeObserver(resize);
      renderer.domElement.addEventListener('webglcontextlost',lost);renderer.domElement.addEventListener('webglcontextrestored',restored);
      ro.observe(el);
      const visibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else resume(); };
      document.addEventListener('visibilitychange', visibility);
      const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) resume(); });
      io.observe(el);
      resize();
      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        renderer.domElement.removeEventListener('webglcontextlost',lost);renderer.domElement.removeEventListener('webglcontextrestored',restored);
        textures.forEach((t) => t.dispose()); geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss();
        renderer.domElement.remove();
        player.style.removeProperty('--beat');
      };
    }).catch(useFallback);
    return () => { disposed = true; cleanup();fallbackCleanup?.(); };
  }, [reduced,graphics]);
  return <div className="fp-backdrop" ref={host} aria-hidden="true" />;
}
