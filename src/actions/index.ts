/**
 * Context-menu actions built by other modules. Each file calls `registerSlot` from
 * src/timeline/contextMenu/registry.ts at import time; importing it here puts it in the menu.
 * The integrator un-comments each line once its module is merged.
 */
import './attributes';
import './editMenu';
import './isolateVoice';
import './compound';
export {};
