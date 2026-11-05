export function handoffCropStart(transitionStartFrame:number,swapAt:number,sampleRate:number):number {
  return Math.max(0,transitionStartFrame+Math.round(swapAt*sampleRate)-6*sampleRate);
}
