import { setLogLevel } from '@percy/shared';

// Keep test output readable; the PII log test raises the level itself.
setLogLevel('WARN');
