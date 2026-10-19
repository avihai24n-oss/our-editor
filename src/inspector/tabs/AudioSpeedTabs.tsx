/**
 * Re-exports: Audio › Basic | Voice changer is in ./AudioTab.tsx, Speed in ./SpeedTab.tsx.
 */
import type { Clip, TimedClip } from '../../model/types';

/** Audio tab: see ./AudioTab.tsx (Basic | Voice changer). */
export { AudioTab } from './AudioTab';

/** Speed › Standard | Curve | Velocity effects lives in ./SpeedTab.tsx. */
export { SpeedTab } from './SpeedTab';

export const isTimed = (c: Clip): c is TimedClip => c.type === 'video' || c.type === 'audio';
