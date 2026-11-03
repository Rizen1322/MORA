import { memo, useId } from 'react';

// Fixed contours: painted once, without a canvas, animation loop or audio reads.
const contours = Array.from({ length: 24 }, (_, i) => ({
  d: `M -50 ${340 + i * 7} C ${110 + i * 3} ${460 - i * 4}, ${140 + i * 3} ${140 - i * 2}, ${300 + i * 2} ${168 + i * 4} S ${450 + i * 3} ${360 + i * 4}, 700 ${90 + i * 7}`,
  opacity: .26 + Math.sin(i / 23 * Math.PI) * .46,
}));

export const WaveStill = memo(function WaveStill() {
  const id = useId();
  return (
    <svg className="wave-still" viewBox="0 0 640 480" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-line`} x1="50" y1="420" x2="600" y2="140" gradientUnits="userSpaceOnUse">
          <stop stopColor="#81d8ae" stopOpacity="0" />
          <stop offset=".28" stopColor="#72cda0" stopOpacity=".55" />
          <stop offset=".58" stopColor="#c1f6d7" />
          <stop offset="1" stopColor="#81d8ae" stopOpacity=".08" />
        </linearGradient>
        <linearGradient id={`${id}-accent`} x1="290" y1="190" x2="570" y2="240" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f0d5a0" stopOpacity="0" />
          <stop offset=".45" stopColor="#f0d5a0" stopOpacity=".7" />
          <stop offset="1" stopColor="#f0d5a0" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke={`url(#${id}-line)`} strokeWidth="1.15">
        {contours.map(({ d, opacity }, i) => <path key={i} d={d} opacity={opacity} vectorEffect="non-scaling-stroke" />)}
      </g>
      <path d={contours[6].d} stroke={`url(#${id}-accent)`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
