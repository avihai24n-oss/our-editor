import type { Plugin } from 'vite';
export function safeDir(dir: string): string | null;
export function safeName(n: string): boolean;
export function freeName(dir: string, name: string): string;
export function saveFiles(): Plugin;
