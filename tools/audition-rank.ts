interface RankedPair {a:{hash:string};b:{hash:string};score:number}
export function rankAuditions<T extends RankedPair>(candidates:T[],entries:{fromHash:string;toHash:string}[],used:Map<string,number>,usedTracks:Map<string,number>) {
  const best=Math.max(...candidates.map(c=>c.score));
  const rank=(c:T)=>c.score-.02*((usedTracks.get(c.a.hash)??0)+(usedTracks.get(c.b.hash)??0))-.04*Number(entries.some(e=>e.fromHash===c.a.hash))-.04*Number(entries.some(e=>e.toHash===c.b.hash))-2*(used.get(`${c.a.hash}/${c.b.hash}`)??0);
  candidates.sort((x,y)=>Number(y.score>=best-.08)-Number(x.score>=best-.08)||rank(y)-rank(x));
}
