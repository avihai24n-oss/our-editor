import type { Plugin } from 'vite';
export const CAPCUT_ROOT: string;
export const ALLOWED_ROOTS: string[];
export function isAllowedPath(p: string, roots?: string[]): boolean;
export function resolveDraftPath(raw: string, folder: string): string | null;
export function localFiles(): Plugin;
