import type { FastifyReply } from 'fastify';

export type ServerEvent =
  | { type: 'lyrics'; trackId:string; hash:string }
  | { type: 'library'; reason: string; trackId?: string }
  | { type: 'analysis'; trackId: string | null; hash: string; status: string; progress?: number; error?: string;asset?:'vocals';revision?:string }
  | { type: 'import'; jobId: string; done: number; total: number; current?: string; errors: number; finished?: boolean }
  | { type: 'providers' }
  | { type: 'playlists' }
  | { type: 'download'; job: { id: string; key: string; title: string; state: string; progress: number; error: string | null; trackId: string | null } };

/** Server-sent events hub. */
export class EventHub {
  private clients = new Set<FastifyReply>();
  private listeners = new Set<(e: ServerEvent) => void>();

  private write(reply:FastifyReply,line:string):void {
    if(reply.raw.destroyed||reply.raw.writableLength>256*1024){
      this.clients.delete(reply);reply.raw.destroy();return;
    }
    try{
      reply.raw.write(line);
      if(reply.raw.writableLength>256*1024){this.clients.delete(reply);reply.raw.destroy();}
    }catch{this.clients.delete(reply);reply.raw.destroy();}
  }

  add(reply: FastifyReply): void {
    this.clients.add(reply);
    reply.raw.on('close', () => this.clients.delete(reply));
  }

  on(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent): void {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of this.clients) {
      this.write(c,line);
    }
    for (const l of this.listeners) l(e);
  }

  heartbeat(): void {
    for (const c of this.clients) {
      this.write(c,': ping\n\n');
    }
  }
}
