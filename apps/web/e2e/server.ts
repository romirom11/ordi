import '../../api/src/server';
import { startRelay } from '../../api/src/workers/relay';

// Realtime belongs to the E2E stack; scheduled business jobs stay disabled.
startRelay(400);
