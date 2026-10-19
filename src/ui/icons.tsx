/**
 * Our Editor — icon kit.
 *
 * Inline-SVG line icons in CapCut desktop's style: 24×24 grid, round caps/joins,
 * `currentColor`, and a stroke that renders at 1.5 screen px at any size
 * (the stroke width is compensated for the viewBox scale).
 *
 * Usage:
 *   import { Icons, Icon } from '../ui/icons';
 *   <Icons.Split />                 // default 18px
 *   <Icons.Play size={24} weight={2} />
 *   <Icon name="Trash" size={16} /> // by name (typed: IconName)
 *
 * Colour follows the parent's CSS `color`, so active/disabled states are pure CSS.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'stroke'> {
  /** Rendered width/height in px. Default 18. */
  size?: number;
  /** Stroke width in *screen* px. Default 1.5. */
  weight?: number;
  /** Accessible label. If omitted the icon is aria-hidden (decorative). */
  title?: string;
}

const VIEW = 24;

function Svg({ size = 18, weight = 1.5, title, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={(weight * VIEW) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
      className={className ? `oe-icon ${className}` : 'oe-icon'}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Helper: build an icon component from SVG children. */
function make(name: string, body: ReactNode) {
  const C = (p: IconProps) => <Svg {...p}>{body}</Svg>;
  C.displayName = `Icon${name}`;
  return C;
}

/** Small filled dot / shape (fill follows currentColor, no stroke). */
const fillProps = { fill: 'currentColor', stroke: 'none' } as const;

/* ------------------------------------------------------------------ */
/* Library tab bar (screenshot 09)                                     */
/* ------------------------------------------------------------------ */

const Media = make('Media', (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M10 9.2v5.6l4.6-2.8z" {...fillProps} />
  </>
));

const Audio = make('Audio', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="10.5" cy="14.5" r="2" />
    <path d="M12.5 14.5V7.5c1.2 0 2.5.8 2.5 2.2" />
  </>
));

const Text = make('Text', (
  <>
    <path d="M3 6h9M7.5 6v12" />
    <path d="M15 6h6M18 6v12M15 18h6" />
  </>
));

const Stickers = make('Stickers', (
  <>
    <path d="M20.5 12A8.5 8.5 0 1 1 12 3.5" />
    <path d="M12 3.5c0 4.7 3.8 8.5 8.5 8.5" />
  </>
));

const Effects = make('Effects', (
  <>
    <path d="M10 3.5l2 4.2 4.6.6-3.4 3.2.9 4.5L10 13.8 5.9 16l.9-4.5-3.4-3.2 4.6-.6z" />
    <path d="M14.5 15l5 5M18 4v3M16.5 5.5h3" />
  </>
));

const Transitions = make('Transitions', (
  <>
    <path d="M4 5l16 14V5L4 19z" />
  </>
));

const Captions = make('Captions', (
  <>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M7 12.5h10M7 15.5h6" />
  </>
));

const Filters = make('Filters', (
  <>
    <circle cx="12" cy="8" r="4.2" />
    <circle cx="8.3" cy="14.5" r="4.2" />
    <circle cx="15.7" cy="14.5" r="4.2" />
  </>
));

const Adjustment = make('Adjustment', (
  <>
    <path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9" />
    <circle cx="15" cy="7.5" r="2" />
    <circle cx="9" cy="16.5" r="2" />
  </>
));

const Templates = make('Templates', (
  <>
    <path d="M13 5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5V11" />
    <path d="M3.5 9.5h9" />
    <path d="M18 2.5l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z" />
  </>
));

/* ------------------------------------------------------------------ */
/* Timeline toolbar, left (screenshot 08)                              */
/* ------------------------------------------------------------------ */

const Select = make('Select', (
  <path d="M5.5 4l13 6.2-5.6 1.6-2.5 5.7z" />
));

/** Split tool (B): a razor blade over a cut line, CapCut's split-mode cursor icon. */
const Blade = make('Blade', (
  <>
    <path d="M8 3h8v5l-4 3-4-3z" />
    <path d="M12 4.8v1.8" />
    <path d="M12 13.5v7.5" />
  </>
));

/** Select leftward ([): pointer + bar with a chevron pointing left. */
const SelectLeft = make('SelectLeft', (
  <>
    <path d="M3.5 3l9 4.3-3.9 1.1-1.7 4z" />
    <path d="M20.5 11v10" />
    <path d="M18 16h-6m2.2-2.2L12 16l2.2 2.2" />
  </>
));

/** Select rightward (]): pointer + bar with a chevron pointing right. */
const SelectRight = make('SelectRight', (
  <>
    <path d="M3.5 3l9 4.3-3.9 1.1-1.7 4z" />
    <path d="M11.5 11v10" />
    <path d="M14 16h6m-2.2-2.2L20 16l-2.2 2.2" />
  </>
));

const Undo = make('Undo', (
  <>
    <path d="M8.5 5L5 8.5 8.5 12" />
    <path d="M5 8.5h9.5a5 5 0 0 1 0 10H9" />
  </>
));

const Redo = make('Redo', (
  <>
    <path d="M15.5 5L19 8.5 15.5 12" />
    <path d="M19 8.5H9.5a5 5 0 0 0 0 10H15" />
  </>
));

/** Split: two brackets facing apart with the cut line between ][ */
const Split = make('Split', (
  <>
    <path d="M6 5h3v14H6" />
    <path d="M18 5h-3v14h3" />
  </>
));

/** Delete left (trim start to playhead): dashed left, bracket right. */
const DeleteLeft = make('DeleteLeft', (
  <>
    <path d="M6 5v2M6 11v2M6 17v2" />
    <path d="M17 5h-3v14h3" />
  </>
));

/** Delete right (trim end to playhead): bracket left, dashed right. */
const DeleteRight = make('DeleteRight', (
  <>
    <path d="M7 5h3v14H7" />
    <path d="M18 5v2M18 11v2M18 17v2" />
  </>
));

const Trash = make('Trash', (
  <>
    <path d="M4 6.5h16M9.5 6.5V4.5h5v2" />
    <path d="M6 6.5l1 13h10l1-13" />
  </>
));

/** Marker: a flag/shield pentagon as in CapCut. */
const Marker = make('Marker', (
  <path d="M6 4.5h12V15l-6 4.5L6 15z" />
));

const Crop = make('Crop', (
  <>
    <path d="M7 3v14h14" />
    <path d="M3 7h14v14" />
  </>
));

const Mirror = make('Mirror', (
  <>
    <path d="M12 3v18" strokeDasharray="2 2.2" />
    <path d="M9 7L3.5 18H9z" />
    <path d="M15 7l5.5 11H15z" />
  </>
));

const Rotate = make('Rotate', (
  <>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M18 2.5v4h-4" />
  </>
));

/** Freeze frame: a frame with a snowflake. */
const Freeze = make('Freeze', (
  <>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M12 8.5v7M9 10.2l6 3.6M15 10.2l-6 3.6" />
  </>
));

/* ------------------------------------------------------------------ */
/* Timeline toolbar, right (screenshot 01)                             */
/* ------------------------------------------------------------------ */

const Mic = make('Mic', (
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
  </>
));

const Magnet = make('Magnet', (
  <>
    <path d="M5 4v8a7 7 0 0 0 14 0V4h-4.5v8a2.5 2.5 0 0 1-5 0V4z" />
    <path d="M5 8h4.5M14.5 8H19" />
  </>
));

const Link = make('Link', (
  <>
    <path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7L11.6 6.7" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </>
));

const Unlink = make('Unlink', (
  <>
    <path d="M15.5 12.5l3.3-3.3a4 4 0 0 0-5.7-5.7L9.8 6.8" />
    <path d="M8.5 11.5l-3.3 3.3a4 4 0 0 0 5.7 5.7l3.3-3.3" />
    <path d="M4 4l16 16" />
  </>
));

/** Preview axis: playhead-like vertical line with a skimming cursor. */
const PreviewAxis = make('PreviewAxis', (
  <>
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
    <path d="M12 3v18" />
    <path d="M10 3h4" />
  </>
));

const ZoomOut = make('ZoomOut', (
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M16 16l4.5 4.5M8 11h6" />
  </>
));

const ZoomIn = make('ZoomIn', (
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M16 16l4.5 4.5M8 11h6M11 8v6" />
  </>
));

/** Fit timeline to window: arrows pointing inward between two bars. */
const ZoomFit = make('ZoomFit', (
  <>
    <path d="M3 5v14M21 5v14" />
    <path d="M6.5 12h4M8.5 10l2 2-2 2M17.5 12h-4M15.5 10l-2 2 2 2" />
  </>
));

/* ------------------------------------------------------------------ */
/* Track headers                                                       */
/* ------------------------------------------------------------------ */

const VideoTrack = make('VideoTrack', (
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <path d="M10.5 9.5v5l4-2.5z" />
  </>
));

const AudioTrack = make('AudioTrack', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8 13v-2M10.7 15V9M13.3 14v-4M16 12.8v-1.6" />
  </>
));

const TextTrack = make('TextTrack', (
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
    <path d="M8 9h8M12 9v7" />
  </>
));

const Lock = make('Lock', (
  <>
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>
));

const Unlock = make('Unlock', (
  <>
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
  </>
));

const Eye = make('Eye', (
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>
));

const EyeOff = make('EyeOff', (
  <>
    <path d="M6.3 7.4C3.9 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.9 0 3.5-.6 4.9-1.5M10 5.7c.6-.1 1.3-.2 2-.2 6 0 9.5 6.5 9.5 6.5s-.8 1.5-2.2 3" />
    <path d="M9.9 10a2.8 2.8 0 0 0 4 4" />
    <path d="M3.5 3.5l17 17" />
  </>
));

const Volume = make('Volume', (
  <>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </>
));

const VolumeMute = make('VolumeMute', (
  <>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
  </>
));

const More = make('More', (
  <>
    <circle cx="6" cy="12" r="1.3" {...fillProps} />
    <circle cx="12" cy="12" r="1.3" {...fillProps} />
    <circle cx="18" cy="12" r="1.3" {...fillProps} />
  </>
));

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

const Play = make('Play', (
  <path d="M7.5 4.8v14.4L19 12z" {...fillProps} />
));

const Pause = make('Pause', (
  <>
    <rect x="6.5" y="5" width="3.5" height="14" rx="1" {...fillProps} />
    <rect x="14" y="5" width="3.5" height="14" rx="1" {...fillProps} />
  </>
));

const Fullscreen = make('Fullscreen', (
  <>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </>
));

const ExitFullscreen = make('ExitFullscreen', (
  <>
    <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
  </>
));

/** Ratio (aspect ratio menu): a rounded box with "Ratio"-style frame. */
const Ratio = make('Ratio', (
  <>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M7 9.5v5M11 10h6v4h-6z" />
  </>
));

/** Fit-to-screen: a viewfinder with corner brackets around a dot. */
const Fit = make('Fit', (
  <>
    <path d="M4 8.5V4h4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" />
    <circle cx="12" cy="12" r="3.5" />
  </>
));

const SkipBack = make('SkipBack', (
  <>
    <path d="M6 5v14" />
    <path d="M19 5v14L8.5 12z" {...fillProps} />
  </>
));

const SkipForward = make('SkipForward', (
  <>
    <path d="M18 5v14" />
    <path d="M5 5v14l10.5-7z" {...fillProps} />
  </>
));

/* ------------------------------------------------------------------ */
/* Inspector + generic                                                 */
/* ------------------------------------------------------------------ */

const Reset = make('Reset', (
  <>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 3.5v4h4" />
  </>
));

/** Keyframe diamond (outline). Use `KeyframeFilled` when a keyframe exists at the playhead. */
const Keyframe = make('Keyframe', (
  <path d="M12 4.5l7.5 7.5-7.5 7.5L4.5 12z" />
));

const KeyframeFilled = make('KeyframeFilled', (
  <path d="M12 4.5l7.5 7.5-7.5 7.5L4.5 12z" fill="currentColor" />
));

const ChevronLeft = make('ChevronLeft', <path d="M14.5 6l-6 6 6 6" />);
const ChevronRight = make('ChevronRight', <path d="M9.5 6l6 6-6 6" />);
const ChevronDown = make('ChevronDown', <path d="M6 9.5l6 6 6-6" />);
const ChevronUp = make('ChevronUp', <path d="M6 14.5l6-6 6 6" />);

/** Small filled caret ▾ (CapCut's section-header triangles). */
const CaretDown = make('CaretDown', <path d="M7 10h10l-5 5.5z" {...fillProps} />);
const CaretUp = make('CaretUp', <path d="M7 14h10l-5-5.5z" {...fillProps} />);

const Plus = make('Plus', <path d="M12 4.5v15M4.5 12h15" />);
const Minus = make('Minus', <path d="M4.5 12h15" />);
const Close = make('Close', <path d="M6 6l12 12M18 6L6 18" />);

const Search = make('Search', (
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5l4.5 4.5" />
  </>
));

const Grid = make('Grid', (
  <>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
  </>
));

const List = make('List', (
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.8" cy="6" r=".9" {...fillProps} />
    <circle cx="4.8" cy="12" r=".9" {...fillProps} />
    <circle cx="4.8" cy="18" r=".9" {...fillProps} />
  </>
));

/** Sort: stacked lines of decreasing length with a down arrow. */
const Sort = make('Sort', (
  <>
    <path d="M4 6h9M4 11h7M4 16h5" />
    <path d="M17.5 5v14M14.5 16l3 3 3-3" />
  </>
));

const Filter = make('Filter', (
  <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
));

/** Import: a plus in a filled circle in CapCut; here outline circle + plus. */
const Import = make('Import', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v8M8 12h8" />
  </>
));

/** Export (CapCut top-right): tray with an up arrow. */
const Export = make('Export', (
  <>
    <path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" />
    <path d="M4.5 12.5v6a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-6" />
  </>
));

const Check = make('Check', <path d="M5 12.5l4.5 4.5L19 7.5" />);

const Settings = make('Settings', (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </>
));

const Record = make('Record', (
  <>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10.5l5-3v9l-5-3z" />
  </>
));

const Menu = make('Menu', <path d="M4 7h16M4 12h16M4 17h16" />);

const Image = make('Image', (
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="M3.5 17l5-4.5 4 3.5 3-2.5 5 4" />
  </>
));

const Speed = make('Speed', (
  <>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="M12 17l4-5" />
  </>
));

const Keyboard = make('Keyboard', (
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M6 12.5h.01M9 12.5h.01M12 12.5h.01M15 12.5h.01M18 12.5h.01M8 15.2h8" />
  </>
));

/* ------------------------------------------------------------------ */
/* Name map                                                            */
/* ------------------------------------------------------------------ */

/** Every icon by name. `Icons.Split`, `Icons.Play`, … */
export const Icons = {
  // library tabs
  Media, Audio, Text, Stickers, Effects, Transitions, Captions, Filters, Adjustment, Templates,
  // timeline toolbar
  Select, Blade, SelectLeft, SelectRight, Undo, Redo, Split, DeleteLeft, DeleteRight, Trash, Marker, Crop, Mirror, Rotate, Freeze,
  // timeline right side
  Mic, Magnet, Link, Unlink, PreviewAxis, ZoomOut, ZoomIn, ZoomFit,
  // track headers
  VideoTrack, AudioTrack, TextTrack, Lock, Unlock, Eye, EyeOff, Volume, VolumeMute, More,
  // player
  Play, Pause, SkipBack, SkipForward, Fullscreen, ExitFullscreen, Ratio, Fit,
  // inspector / generic
  Reset, Keyframe, KeyframeFilled,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CaretDown, CaretUp,
  Plus, Minus, Close, Search, Grid, List, Sort, Filter, Import, Export, Check,
  Settings, Record, Menu, Image, Speed, Keyboard,
  // aliases (names used in the brief / research docs)
  Pointer: Select,
  Delete: Trash,
  Snap: Magnet,
} as const;

export type IconName = keyof typeof Icons;
export type IconComponent = (typeof Icons)[IconName];

/** All icon names, in declaration order (aliases included). */
export const iconNames = Object.keys(Icons) as IconName[];

/** Render an icon by name: `<Icon name="Split" />`. */
export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const C = Icons[name];
  return <C {...props} />;
}
