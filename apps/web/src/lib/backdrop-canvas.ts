import { controller } from '../store/app.ts';
import { AudibleMotion,audibleDelay } from './audible-motion.ts';

/** Low-resolution software backdrop for GPUs without WebGL2. No cover decoding
 * or readback: uses the already blended artwork colours of the player. */
export function startBackdropCanvas(el:HTMLElement,player:HTMLElement,reduced:boolean):()=>void {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{alpha:false});if(!ctx)return ()=>{};
  canvas.className='backdrop-canvas-fallback';el.appendChild(canvas);el.classList.add('is-canvas');el.dataset.renderer='canvas';
  const bins=new Float32Array(1024),waveform=new Float32Array(2048),motion=new AudibleMotion();
  let disposed=false,visible=true,raf=0,last=0,time=0,width=1,height=1,tintWait=0,color='28,74,52';
  const draw=(now:number)=>{
    raf=0;if(disposed||!visible||document.hidden)return;
    if(!reduced&&last&&now-last<1000/(controller.state.status==='playing'?24:8)-2){raf=requestAnimationFrame(draw);return;}
    const dt=last?Math.min(.12,(now-last)/1000):0;last=now;time+=dt*.7;
    const an=controller.analyser;
    if(!reduced&&an&&controller.state.status==='playing'){an.getFloatFrequencyData(bins);an.getFloatTimeDomainData(waveform);motion.update(bins,waveform,an.context.sampleRate,an.fftSize,dt,now/1000,audibleDelay(an.context,now));}
    else motion.update(null,null,48000,2048,dt,now/1000,0);
    tintWait-=dt;if(tintWait<=0){const a=getComputedStyle(document.documentElement).getPropertyValue('--art').trim().split(/\s+/).map(Number);if(a.length===3&&a.every(Number.isFinite))color=a.map(x=>Math.max(0,Math.min(255,Math.round(x)))).join(',');tintWait=.5;}
    ctx.fillStyle='#08130f';ctx.fillRect(0,0,width,height);
    for(let i=0;i<3;i++){
      const x=width*(.5+Math.sin(time*(.16+i*.05)+i*2)*(.3+motion.mid*.12)),y=height*(.5+Math.cos(time*.2+i)*.3),r=Math.max(width,height)*(.55+motion.bass*.12+motion.kick*.08);
      const gradient=ctx.createRadialGradient(x,y,0,x,y,r);gradient.addColorStop(0,`rgba(${color},${.7+motion.kick*.2})`);gradient.addColorStop(1,`rgba(${color},0)`);ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);
    }
    player.style.setProperty('--beat',String(Math.round(Math.min(1,motion.kick*.8+motion.level*.25)*100)/100));
    if(!reduced)raf=requestAnimationFrame(draw);
  };
  const resume=()=>{if(!raf&&!disposed&&visible&&!document.hidden){last=0;raf=requestAnimationFrame(draw);}};
  const resize=()=>{const r=el.getBoundingClientRect(),scale=Math.min(.4,400/Math.max(1,r.width,r.height));width=canvas.width=Math.max(1,Math.round(r.width*scale));height=canvas.height=Math.max(1,Math.round(r.height*scale));resume();};
  const ro=new ResizeObserver(resize);ro.observe(el);const io=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible)resume();else{cancelAnimationFrame(raf);raf=0;}});io.observe(el);
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else resume();};document.addEventListener('visibilitychange',visibility);resize();
  return ()=>{disposed=true;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();document.removeEventListener('visibilitychange',visibility);canvas.remove();el.classList.remove('is-canvas');delete el.dataset.renderer;player.style.removeProperty('--beat');};
}
