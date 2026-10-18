/**
 * Kebab-case adapter over ./icons, for code that names icons as strings
 * (`<Icon name="chevron-down" />`, `IconButton icon="reset"` in ./controls).
 * Same components as `Icons` in ./icons — PascalCase `Icons.ChevronDown` == kebab 'chevron-down'.
 * Generated from the Icons map; add new icons in icons.tsx and here.
 */
import { Icons, type IconProps } from './icons';

export const iconsByName = {
  'media': Icons.Media,
  'audio': Icons.Audio,
  'text': Icons.Text,
  'stickers': Icons.Stickers,
  'effects': Icons.Effects,
  'transitions': Icons.Transitions,
  'captions': Icons.Captions,
  'filters': Icons.Filters,
  'adjustment': Icons.Adjustment,
  'templates': Icons.Templates,
  'select': Icons.Select,
  'undo': Icons.Undo,
  'redo': Icons.Redo,
  'split': Icons.Split,
  'delete-left': Icons.DeleteLeft,
  'delete-right': Icons.DeleteRight,
  'trash': Icons.Trash,
  'marker': Icons.Marker,
  'crop': Icons.Crop,
  'mirror': Icons.Mirror,
  'rotate': Icons.Rotate,
  'freeze': Icons.Freeze,
  'mic': Icons.Mic,
  'magnet': Icons.Magnet,
  'link': Icons.Link,
  'unlink': Icons.Unlink,
  'preview-axis': Icons.PreviewAxis,
  'zoom-out': Icons.ZoomOut,
  'zoom-in': Icons.ZoomIn,
  'zoom-fit': Icons.ZoomFit,
  'video-track': Icons.VideoTrack,
  'audio-track': Icons.AudioTrack,
  'text-track': Icons.TextTrack,
  'lock': Icons.Lock,
  'unlock': Icons.Unlock,
  'eye': Icons.Eye,
  'eye-off': Icons.EyeOff,
  'volume': Icons.Volume,
  'volume-mute': Icons.VolumeMute,
  'more': Icons.More,
  'play': Icons.Play,
  'pause': Icons.Pause,
  'skip-back': Icons.SkipBack,
  'skip-forward': Icons.SkipForward,
  'fullscreen': Icons.Fullscreen,
  'exit-fullscreen': Icons.ExitFullscreen,
  'ratio': Icons.Ratio,
  'fit': Icons.Fit,
  'reset': Icons.Reset,
  'keyframe': Icons.Keyframe,
  'keyframe-filled': Icons.KeyframeFilled,
  'chevron-left': Icons.ChevronLeft,
  'chevron-right': Icons.ChevronRight,
  'chevron-down': Icons.ChevronDown,
  'chevron-up': Icons.ChevronUp,
  'caret-down': Icons.CaretDown,
  'caret-up': Icons.CaretUp,
  'plus': Icons.Plus,
  'minus': Icons.Minus,
  'close': Icons.Close,
  'search': Icons.Search,
  'grid': Icons.Grid,
  'list': Icons.List,
  'sort': Icons.Sort,
  'filter': Icons.Filter,
  'import': Icons.Import,
  'export': Icons.Export,
  'check': Icons.Check,
  'settings': Icons.Settings,
  'record': Icons.Record,
  'menu': Icons.Menu,
  'image': Icons.Image,
  'speed': Icons.Speed,
  'pointer': Icons.Pointer,
  'delete': Icons.Delete,
  'snap': Icons.Snap,
  // extra aliases
  'x': Icons.Close,
  'delete-icon': Icons.Trash,
} as const;

export type IconName = keyof typeof iconsByName;
export type { IconProps };

export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  const C = iconsByName[name];
  return <C {...props} />;
}
