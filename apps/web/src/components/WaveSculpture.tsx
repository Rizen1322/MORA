import { useEffect, useRef } from 'react';
import { controller, useApp } from '../store/app.ts';
import { useReducedMotion } from './common.tsx';
import { AudibleMotion, audibleDelay } from '../lib/audible-motion.ts';
import { startSculptureCanvas } from '../lib/sculpture-canvas.ts';

/** Lazy, isolated WebGL scene: no changes to the audio graph or playback clock. */
export function WaveSculpture({ energy }: { energy: number }) {
  const host = useRef<HTMLDivElement>(null);
  const energyRef = useRef(energy);
  energyRef.current = energy;
  const reduced = useReducedMotion();
  const covered = useApp(s => s.fullPlayer);
  const graphics = useApp(s => s.settings?.ui.graphics ?? 'auto');
  useEffect(() => {
    const el = host.current;
    if (!el || reduced || covered) return;
    let disposed = false;
    let cleanup = () => {};
    let fallbackCleanup: (()=>void)|null=null;
    const fallback=()=>{if(!disposed&&!fallbackCleanup){el.classList.remove('is-webgl');fallbackCleanup=startSculptureCanvas(el);}};
    if(graphics==='canvas'){fallback();return ()=>{disposed=true;fallbackCleanup?.();};}
    void import('three').then((T) => {
      if (disposed) return;
      let renderer: InstanceType<typeof T.WebGLRenderer>;
      try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
      catch { fallback(); return; }
      renderer.domElement.className='wave-webgl-canvas';
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      el.appendChild(renderer.domElement);
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(36, 1, 0.1, 30);
      camera.position.z = 6.8;
      const group = new T.Group();
      group.rotation.set(0.38, -0.2, -0.35);
      scene.add(group);
      const material = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        uniforms: {
          time: { value: 0 }, energy: { value: energyRef.current },
          bass: { value: 0 }, mid: { value: 0 }, high: { value: 0 }, kick: { value: 0 }, blend: { value: 0 },
          bands: { value: new Float32Array(16) }, level: { value: 0 },
        },
        vertexShader: `uniform float time; uniform float energy; uniform float bass; uniform float mid; uniform float high; uniform float kick; uniform float bands[16]; uniform float level;
          varying float glow; varying float depth; varying float lift;
          void main() {
            vec3 p = position;
            float a = atan(p.y, p.x);
            // Bass swells the whole body, kicks punch it outwards, mids ripple the rim, highs shimmer.
            float sector = fract((a + 3.14159265359) / 6.28318530718) * 16.0;
            float local = mix(bands[int(floor(sector))], bands[int(mod(floor(sector) + 1.0, 16.0))], smoothstep(0.0, 1.0, fract(sector)));
            float swell = 1.0 + bass * .22 + kick * .16;
            float ripple = sin(a * 6.0 + time * 1.1 + p.z * 3.0) * (.025 + mid * .12) + local * .13;
            float shimmer = sin(a * 22.0 + p.z * 11.0 - time * 5.0) * high * .045;
            p.xy *= swell + ripple + shimmer + sin(a * 3.0 - time * .4) * .055;
            p.z += sin(a * 4.0 + time * .7) * (.12 + energy * .06 + bass * .25) + sin(a * 9.0 - time * 2.0) * kick * .12;
            lift = clamp(bass * .8 + kick, 0.0, 1.0);
            glow = .32 + .5 * pow(.5 + .5 * sin(a * 3.0 + p.z * 2.0 - time * .8), 3.0) + local * .35 + level * .12;
            depth = p.z;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `uniform float kick; uniform float mid; uniform float blend;
          varying float glow; varying float depth; varying float lift;
          void main() {
            vec3 mint = vec3(.38, .94, .69);
            vec3 pearl = vec3(.88, 1.0, .9);
            vec3 amber = vec3(.96, .78, .43);
            vec3 c = mix(mint, pearl, clamp(smoothstep(-.3, .5, depth) + kick * .45, 0.0, 1.0));
            c = mix(c, amber, blend * .55); // AutoMix blend in progress
            gl_FragColor = vec4(c, glow * (.34 + lift * .5 + mid * .18));
          }`,
      });
      const geometries: InstanceType<typeof T.BufferGeometry>[] = [];
      const vertices = new Float32Array(72 * 240 * 6); let vertex = 0;
      // Parallel filaments on a toroidal surface, rather than a solid stock torus.
      for (let j = 0; j < 72; j++) {
        const v = j / 72 * Math.PI * 2;
        const points = [];
        for (let i = 0; i <= 240; i++) {
          const u = i / 240 * Math.PI * 2;
          const radius = 1.4 + .43 * Math.cos(v + u * 2);
          points.push(new T.Vector3(radius * Math.cos(u), radius * Math.sin(u), .43 * Math.sin(v + u * 2)));
        }
        for (let i = 0; i < 240; i++) for (const p of [points[i], points[i + 1]]) { vertices[vertex++] = p.x; vertices[vertex++] = p.y; vertices[vertex++] = p.z; }
      }
      const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.BufferAttribute(vertices, 3));
      geometries.push(geometry); group.add(new T.LineSegments(geometry, material));
      let visible = true, contextLost = false, raf = 0, last = 0, time = 0;
      renderer.debug.onShaderError=()=>{contextLost=true;cancelAnimationFrame(raf);raf=0;fallback();};
      const pointer = { x: 0, y: 0 };
      const bins = new Float32Array(1024), waveform = new Float32Array(2048);
      const motion = new AudibleMotion();
      // Smoothed bands (fast attack, slow release) and a kick envelope from bass onsets.
      const lv = motion; let mix = 0;
      const draw = (now: number) => {
        raf = 0;
        if (disposed || contextLost || !visible || document.hidden) return;
        // Bound GPU work independently of 120–165 Hz display refresh.
        const active = controller.state.status === 'playing';
        if (last && now - last < 1000 / (active ? 45 : 12) - 2) { raf = requestAnimationFrame(draw); return; }
        const dt = last ? Math.min((now - last) / 1000, .12) : 0;
        last = now;
        const an = controller.analyser;
        const st = controller.state;
        if (an && st.status === 'playing') {
          an.getFloatFrequencyData(bins); an.getFloatTimeDomainData(waveform);
          motion.update(bins, waveform, an.context.sampleRate, an.fftSize, dt, now / 1000, audibleDelay(an.context, now));
        } else {
          motion.update(null, null, 48000, 2048, dt, now / 1000, 0);
        }
        const tr = st.transition;
        mix += ((tr?.active ? Math.sin(Math.PI * Math.min(1, Math.max(0, tr.progress))) : 0) - mix) * (1 - Math.exp(-dt / .2));
        time += dt * .7; // Ambient drift is not a second, artificial beat clock.
        const u = material.uniforms;
        u.time.value = time;
        u.energy.value = energyRef.current;
        u.bass.value = lv.bass; u.mid.value = lv.mid; u.high.value = lv.high; u.kick.value = lv.kick; u.blend.value = mix;
        u.bands.value = motion.bands; u.level.value = motion.level;
        group.scale.setScalar(1 + lv.kick * .05);
        group.rotation.y += (pointer.x * .2 - group.rotation.y) * .025;
        group.rotation.x += (.38 + pointer.y * .15 - group.rotation.x) * .025;
        group.rotation.z = -.35 + Math.sin(time * .18) * (.08 + lv.mid * .12);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(draw);
      };
      const resume = () => { if (!raf && !contextLost && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(draw); } };
      const resize = () => {
        const { width, height } = el.getBoundingClientRect();
        renderer.setSize(Math.max(1, width), Math.max(1, height));
        camera.aspect = width / Math.max(1, height);
        // Include deformation and kick expansion in the fit, on both axes.
        camera.position.z = 1.2 + 2.85 / Math.tan(36 * Math.PI / 360) / Math.min(1, Math.max(.2, camera.aspect));
        camera.updateProjectionMatrix();
        resume();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      const io = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (!visible) { cancelAnimationFrame(raf); raf = 0; } else resume();
      });
      io.observe(el);
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        pointer.x = (e.clientX - r.left) / r.width - .5;
        pointer.y = (e.clientY - r.top) / r.height - .5;
      };
      const visibility = () => {
        if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else resume();
      };
      const lost = (e: Event) => { e.preventDefault(); contextLost = true; cancelAnimationFrame(raf); raf = 0; fallback(); };
      const restored = () => { contextLost = false; fallbackCleanup?.();fallbackCleanup=null;el.dataset.renderer='webgl';el.classList.add('is-webgl');resume(); };
      renderer.domElement.addEventListener('webglcontextlost', lost);
      renderer.domElement.addEventListener('webglcontextrestored', restored);
      el.addEventListener('pointermove', move);
      document.addEventListener('visibilitychange', visibility);
      el.classList.add('is-webgl');
      el.dataset.renderer='webgl';
      resize();
      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        el.removeEventListener('pointermove', move);
        renderer.domElement.removeEventListener('webglcontextlost', lost);
        renderer.domElement.removeEventListener('webglcontextrestored', restored);
        geometries.forEach((g) => g.dispose()); material.dispose(); renderer.dispose(); renderer.forceContextLoss();
        renderer.domElement.remove(); el.classList.remove('is-webgl');if(el.dataset.renderer==='webgl')delete el.dataset.renderer;
      };
    }).catch(fallback);
    return () => { disposed = true; cleanup();fallbackCleanup?.(); };
  }, [reduced, covered, graphics]);
  return <div className="wave-sculpture" ref={host} aria-hidden="true"><div className="wave-sculpture-fallback" /></div>;
}
