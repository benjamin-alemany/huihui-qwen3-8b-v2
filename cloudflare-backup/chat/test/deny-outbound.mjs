// Additional protection for auxiliary Workers, which do not inherit test mocks.
import {appendFileSync} from 'node:fs';
export function denyOutbound(){if(process.env.UNJAILED_TEST_VIOLATION_FILE)appendFileSync(process.env.UNJAILED_TEST_VIOLATION_FILE,'unexpected outbound request\n');throw Error('Unexpected outbound request in local tests');}
