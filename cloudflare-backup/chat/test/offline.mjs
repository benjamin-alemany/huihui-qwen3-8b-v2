import {afterEach,vi,expect} from 'vitest';
const blocked=[];
// Applies to the main Worker and DO alarms in this isolate. Auxiliary workers
// also have an outboundService deny; the runner enforces OS denial for all code.
vi.stubGlobal('fetch',async()=>{blocked.push('unexpected fetch');throw Error('Unexpected external request; supply an explicit dummy response');});
afterEach(()=>{expect(blocked.splice(0)).toEqual([]);});
