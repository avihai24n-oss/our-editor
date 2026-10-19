/**
 * Shared helpers for the audit specs (audit-library, audit-render, audit-export).
 *
 * Each audit wrote its own helpers; they live in e2e/audit/<area>.ts and are re-exported here so
 * every spec imports from one module. Names that two areas both defined are namespaced:
 *   - render: RENDER_AM (synthetic media table, e2e/audit-media/), ensureRenderMedia()
 *   - export: EXPORT_AM (synthetic media table, e2e/.audit-media/), ensureExportMedia()
 */
export * from './audit/library';
export * from './audit/render';
export * from './audit/export';
