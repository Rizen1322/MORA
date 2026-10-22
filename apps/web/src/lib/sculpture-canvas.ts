import { controller } from '../store/app.ts';
import { AudibleMotion, audibleDelay } from './audible-motion.ts';

export const SCULPTURE_RINGS=24, SCULPTURE_SEGMENTS=96;
export interface SculptureMotion { bass:number; mid:number; high:number; kick:number; level:number; bands:ArrayLike<number> }

/** Perspective-projected filaments, also usable when WebGL2 is unavailable.
 * Reuses the caller's vertex buffer. The last vertex closes exactly on the first. */
export function projectSculpture(out:Float32Array,time:number,m:SculptureMotion,width:number,height:number):void {
  const scale=Math.min(width,height)*.96,rz=-.35+Math.sin(time*.18)*.08,cz=Math.cos(rz),sz=Math.sin(rz),rx=.38+Math.sin(time*.12)*.08,cx=Math.cos(rx),sx=Math.sin(rx);
  let at=0,extent=0;
  for(let j=0;j<SCULPTURE_RINGS;j++){
    const v=j/SCULPTURE_RINGS*Math.PI*2;
    for(let i=0;i<=SCULPTURE_SEGMENTS;i++){
      const u=(i%SCULPTURE_SEGMENTS)/SCULPTURE_SEGMENTS*Math.PI*2,sector=u/(Math.PI*2)*16,k=Math.floor(sector),fraction=sector-k,f=fraction*fraction*(3-2*fraction);
      const band=(m.bands[k%16]??0)*(1-f)+(m.bands[(k+1)%16]??0)*f;
      const ripple=1+m.bass*.22+m.kick*.16+Math.sin(u*6+time*1.1)*(.025+m.mid*.12)+band*.13+Math.sin(u*3-time*.4)*.055;
      const radius=(1.4+.43*Math.cos(v+u*2))*ripple;
      const x=radius*Math.cos(u),y=radius*Math.sin(u),z=.43*Math.sin(v+u*2)+Math.sin(u*4+time*.7)*(.12+m.bass*.25);
      const yy=y*cx-z*sx,zz=y*sx+z*cx,perspective=scale/(4.8-zz);
      const px=(x*cz-yy*sz)*perspective,py=(x*sz+yy*cz)*perspective;
      extent=Math.max(extent,Math.abs(px)/Math.max(1,width),Math.abs(py)/Math.max(1,height));
      out[at++]=width*.5+px;out[at++]=height*.5+py;
    }
  }
  // Fit the actual deformation, including the loudest kick, to either aspect.
  if(extent>.47){const fit=.47/extent;for(let i=0;i<out.length;i+=2){out[i]=width*.5+(out[i]-width*.5)*fit;out[i+1]=height*.5+(out[i+1]-height*.5)*fit;}}
}

export function startSculptureCanvas(el:HTMLElement):()=>void {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{alpha:true});
  if(!ctx)return ()=>{};
  canvas.className='wave-canvas-fallback';el.appendChild(canvas);el.classList.add('is-canvas');el.dataset.renderer='canvas';
  const vertices=new Float32Array(SCULPTURE_RINGS*(SCULPTURE_SEGMENTS+1)*2),bins=new Float32Array(1024),waveform=new Float32Array(2048),motion=new AudibleMotion();
  let raf=0,last=0,time=0,visible=true,disposed=false,width=1,height=1;
  const draw=(now:number)=>{
    raf=0;if(disposed||!visible||document.hidden)return;
    const playing=controller.state.status==='playing';
    if(last&&now-last<1000/(playing?24:10)-2){raf=requestAnimationFrame(draw);return;}
    const dt=last?Math.min(.12,(now-last)/1000):0;last=now;time+=dt*.7;
    const an=controller.analyser;
    if(an&&playing){an.getFloatFrequencyData(bins);an.getFloatTimeDomainData(waveform);motion.update(bins,waveform,an.context.sampleRate,an.fftSize,dt,now/1000,audibleDelay(an.context,now));}
    else motion.update(null,null,48000,2048,dt,now/1000,0);
    projectSculpture(vertices,time,motion,width,height);ctx.clearRect(0,0,width,height);
    ctx.lineWidth=.65+motion.kick*.2;ctx.strokeStyle='#8bf5be';
    let at=0;
    for(let j=0;j<SCULPTURE_RINGS;j++){
      ctx.globalAlpha=.2+.2*(.5+.5*Math.cos(j/SCULPTURE_RINGS*Math.PI*2))+motion.level*.15;
      ctx.beginPath();for(let i=0;i<=SCULPTURE_SEGMENTS;i++){const x=vertices[at++],y=vertices[at++];if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
    }
    raf=requestAnimationFrame(draw);
  };
  const resume=()=>{if(!raf&&!disposed&&visible&&!document.hidden){last=0;raf=requestAnimationFrame(draw);}};
  const resize=()=>{const r=el.getBoundingClientRect();width=Math.max(1,r.width);height=Math.max(1,r.height);const dpr=Math.min(1.25,window.devicePixelRatio||1);canvas.width=Math.ceil(width*dpr);canvas.height=Math.ceil(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);resume();};
  const ro=new ResizeObserver(resize);ro.observe(el);
  const io=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(!visible){cancelAnimationFrame(raf);raf=0;}else resume();});io.observe(el);
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else resume();};document.addEventListener('visibilitychange',visibility);resize();
  return ()=>{disposed=true;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();document.removeEventListener('visibilitychange',visibility);canvas.remove();el.classList.remove('is-canvas');if(el.dataset.renderer==='canvas')delete el.dataset.renderer;};
}
