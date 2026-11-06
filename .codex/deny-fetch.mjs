// Node-side safeguard, in addition to OS egress denial. Test doubles are explicit.
let unexpected=0;
const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(['localhost','127.0.0.1','[::1]'].includes(u.hostname))return original(input,options);unexpected++;throw Error('Unexpected external fetch in a dummy-only test');};
process.on('beforeExit',()=>{if(unexpected){console.error('Unexpected Node fetch attempts:',unexpected);process.exitCode=1;}});
