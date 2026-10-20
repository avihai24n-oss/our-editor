/** Line icons for the context menu's icon column (16 px, currentColor). */
import type { ReactNode } from 'react';
import { iconsByName } from '../../ui/Icon';

const P = (d: string) => <path d={d} />;

export const ICONS: Record<string, ReactNode> = {
  sparkle: P('M8 1.5l1.6 4.2 4.4 1.3-4.4 1.3L8 12.5 6.4 8.3 2 7l4.4-1.3z M13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z'),
  copy: P('M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3'),
  cut: P('M4.5 13.5a2 2 0 1 0 0-.01z M11.5 13.5a2 2 0 1 0 0-.01z M5.8 12L12 2.5 M10.2 12L4 2.5'),
  attributes: P('M2.5 3.5h11 M2.5 8h11 M2.5 12.5h11 M5.5 2v3 M10.5 6.5v3 M7 11v3'),
  trash: P('M2.5 4h11 M6 4V2.5h4V4 M4 4l.7 9.5h6.6L12 4 M6.7 6.5v4.5 M9.3 6.5v4.5'),
  edit: P('M10.5 2.5l3 3-8 8h-3v-3z M9 4l3 3'),
  scenes: P('M2 3.5h12v9H2z M6 3.5v9 M10 3.5v9'),
  transcript: P('M3 2.5h10v11H3z M5.5 5.5h5 M5.5 8h5 M5.5 10.5h3'),
  captions: P('M1.5 3.5h13v9h-13z M4 8.5h3 M8.5 8.5h3.5 M4 10.5h5 M10.5 10.5h1.5'),
  voice: P('M8 1.5a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0v-4a2 2 0 0 1 2-2z M4 7.5a4 4 0 0 0 8 0 M8 11.5v3'),
  'extract-audio': P('M2 10.5v-5 M5 12.5v-9 M8 10v-4 M11 13v-10 M14 10.5v-5'),
  'remove-bg': P('M2.5 2.5h11v11h-11z M5.5 13.5a2.5 3 0 0 1 5 0 M8 9a2 2 0 1 0 0-.01z'),
  'enhance-audio': P('M2 8h2l2-5 2.5 10 2-7 1.5 2h2'),
  'enhance-visuals': P('M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 1 0 0-.01z'),
  'adjust-color': P('M8 1.5a6.5 6.5 0 1 0 0 13c1 0 1.5-.7 1.5-1.4 0-1.2-1-1.3-1-2.3 0-.8.6-1.3 1.4-1.3h1.6a3 3 0 0 0 3-3C14.5 3.9 11.6 1.5 8 1.5z M4.5 8h.01 M6 5h.01 M9.5 4.5h.01'),
  'enhance-motion': P('M1.5 5h6 M1.5 8h4 M1.5 11h6 M10 3.5l4 4.5-4 4.5'),
  group: P('M1.5 4.5h6v6h-6z M8.5 5.5h6v6h-6z'),
  compound: P('M2.5 2.5h11v11h-11z M5 5.5h6 M5 8h6 M5 10.5h6'),
  preset: P('M3.5 2.5h9v11L8 10.5l-4.5 3z'),
  export: P('M8 10V2 M5 5l3-3 3 3 M2.5 9.5v4h11v-4'),
  deactivate: P('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z M3.4 3.4l9.2 9.2'),
  more: P('M3.5 8h.01 M8 8h.01 M12.5 8h.01'),
  range: P('M2.5 3v10 M13.5 3v10 M2.5 8h11 M5 5.5L2.5 8 5 10.5 M11 5.5l2.5 2.5-2.5 2.5'),
  render: P('M2.5 2.5h11v11h-11z M6 5.5l4.5 2.5L6 10.5z'),
};

export function MenuIcon({ name }: { name?: string }) {
  if (!name) return <span className="ctxm__icon" />;
  const own = ICONS[name];
  if (own)
    return (
      <svg className="ctxm__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {own}
      </svg>
    );
  const Shared = (iconsByName as Record<string, ((p: { size?: number }) => ReactNode) | undefined>)[name];
  return <span className="ctxm__icon">{Shared ? <Shared size={16} /> : null}</span>;
}
