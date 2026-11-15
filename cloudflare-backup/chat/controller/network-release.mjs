// No existing image has passed the production egress boundary gate.
// This is a reviewed source pin, not an environment flag or browser receipt.
export const APPROVED_NETWORK_IMAGE=null;
export const networkReleaseReady=image=>APPROVED_NETWORK_IMAGE!==null&&image===APPROVED_NETWORK_IMAGE;
