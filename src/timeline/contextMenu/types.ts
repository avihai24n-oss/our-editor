/**
 * Clip right-click menu contract (shared with the context-menu UI). Feature modules build
 * `MenuItem`s and register them into named slots (./registry.ts); the menu renders the slots.
 */
export interface MenuCtx { clipIds: string[]; primaryId: string; trackId: string; time: number }
export interface MenuItem { id: string; label: string; icon?: string; shortcut?: string; disabled?: (ctx: MenuCtx) => boolean; hidden?: (ctx: MenuCtx) => boolean; tag?: 'Soon'|'Free'|'Pro'; run?: (ctx: MenuCtx) => void; submenu?: (ctx: MenuCtx) => MenuItem[] }
