import { ImportService } from '../index';
import { contactSgRuntime } from './runtime';

const deps = contactSgRuntime('contactsg-scan-result');
const imports = new ImportService(deps);

interface BridgeEvent {
  id: string;
  'detail-type': string;
  detail: {
    object?: { key?: string };
    s3ObjectDetails?: { objectKey?: string };
    scanResultDetails?: { scanResultStatus?: string };
  };
}

/** EventBridge target for S3 "Object Created" (→ SCANNING) and the GuardDuty scan result (FR-CON-04). */
export async function handler(event: BridgeEvent): Promise<void> {
  if (event['detail-type'] === 'Object Created') {
    const key = decodeURIComponent((event.detail.object?.key ?? '').replace(/\+/g, ' '));
    await imports.onObjectCreated(key);
    return;
  }
  const key = event.detail.s3ObjectDetails?.objectKey ?? '';
  const status = event.detail.scanResultDetails?.scanResultStatus ?? 'FAILED';
  deps.logger.info('scan result', { status, eventId: event.id });
  await imports.onScanResult(key, status, event.id);
}
