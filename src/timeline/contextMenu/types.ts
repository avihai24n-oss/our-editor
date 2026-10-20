/** Clip right-click menu contract (shared with the menu UI). */
export interface MenuCtx { clipIds: string[]; primaryId: string; trackId: string; time: number }
export interface MenuItem { id: string; label: string; icon?: string; shortcut?: string; disabled?: (ctx: MenuCtx) => boolean; hidden?: (ctx: MenuCtx) => boolean; tag?: 'Soon'|'Free'|'Pro'; run?: (ctx: MenuCtx) => void; submenu?: (ctx: MenuCtx) => MenuItem[] }
