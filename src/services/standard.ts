import { createRegistry } from './registry.ts';
import type { ServiceRegistry } from './types.ts';
import { directoryService } from './directory.ts';

// ---------- the standard, pre-seeded registry ----------
//
// The registry the DI layer injects in production. Kept SEPARATE from registry.ts (the
// cycle-free mechanism) because it imports the service implementations, which import the
// compiler's stream/q kernel — importing this from the compiler core would cycle. Only
// application(deps) and the runtime entry points touch this module. Every Phase-1-5
// service is pure SQL, identical on both runtimes; Phase 6's federated service will take a
// per-runtime env, at which point this becomes a factory over that env.

/** The standard services, in --list enumeration order. Added as each phase lands. */
export const standardRegistry: ServiceRegistry = createRegistry([directoryService]);
