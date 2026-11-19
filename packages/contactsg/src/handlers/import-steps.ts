import { ImportService, type ChunkResult, type ImportRef } from '../index';
import { contactSgRuntime } from './runtime';

const imports = new ImportService(contactSgRuntime('contactsg-import'));

type StepInput =
  | { step: 'validate'; ref: ImportRef }
  | { step: 'chunk'; ref: ImportRef; chunkKey: string }
  | { step: 'summarise'; ref: ImportRef; results: ChunkResult[] }
  | { step: 'fail'; ref: ImportRef; reason?: string };

/** Task Lambda for the import state machine (Validate → Map(chunks) → Summarise, Catch → Fail). */
export async function handler(input: StepInput): Promise<unknown> {
  switch (input.step) {
    case 'validate': {
      const out = await imports.validate(input.ref);
      if ('failed' in out) {
        await imports.fail(input.ref, out.failed);
        return { ok: false, chunkKeys: [] };
      }
      return { ok: true, chunkKeys: out.chunkKeys };
    }
    case 'chunk':
      return imports.importChunk(input.ref, input.chunkKey);
    case 'summarise':
      await imports.summarise(input.ref, input.results);
      return { ok: true };
    case 'fail':
      await imports.fail(input.ref, input.reason ?? 'The import failed unexpectedly. Please upload the file again.');
      return { ok: false };
  }
}
