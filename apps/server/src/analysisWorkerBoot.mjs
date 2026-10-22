// Worker bootstrap: registers the tsx loader inside the worker thread, then
// loads the TypeScript worker. Node's built-in type stripping does not support
// all TypeScript syntax used by the DSP core.
import { register } from 'tsx/esm/api';

register();
await import('./analysisWorker.ts');
