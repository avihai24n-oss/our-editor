import type { Plugin } from 'vite';
export function listModels(dir?: string): { id: string; file: string; dtw: string }[];
export const LANGS: Set<string>;
export function whisperArgs(o: { model: string; dtw?: string; lang: string; wav: string; outBase: string; threads: number }): string[];
export function transcribe(): Plugin;
