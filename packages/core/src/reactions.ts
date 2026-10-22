export type ReactionValue = -1 | 0 | 1;

export interface ReactionSync {
  status: 'synced' | 'pending' | 'error' | 'local';
  error?: string;
}
