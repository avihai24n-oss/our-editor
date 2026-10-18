/**
 * Our Editor — UI primitives (CapCut-style dark controls).
 *
 *   import { IconButton, Button, ToolbarDivider } from '../ui/primitives';
 *   import { Icons } from '../ui/icons';
 *
 *   <IconButton icon={Icons.Split} label="Split (Ctrl+B)" onClick={split} />
 *   <IconButton icon={Icons.Magnet} label="Snap" active={snap} onClick={toggle} />
 *   <Button variant="primary" icon={Icons.Export}>Export</Button>
 *
 * Styling lives in primitives.css (imported here, so importing this module is enough).
 * Colours come from theme CSS variables with fallbacks.
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react';
import type { IconProps } from './icons';
import './primitives.css';

type IconLike = ComponentType<IconProps>;

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Icon component, e.g. `Icons.Split`. */
  icon: IconLike;
  /** Tooltip text (native `title`) and aria-label. Put the shortcut in it: "Split (Ctrl+B)". */
  label: string;
  /** Toggled-on state (cyan), e.g. snapping enabled. Sets aria-pressed. */
  active?: boolean;
  /** Icon size in px. Default 18. */
  size?: number;
  /** `sm` = 24px hit box (track headers), `md` = 28px (toolbars, default), `lg` = 36px (player). */
  box?: 'sm' | 'md' | 'lg';
  /** Show a small ▾ caret at the bottom-right (CapCut's "has a dropdown" mark). */
  caret?: boolean;
  /** Small cyan dot at the top-right (CapCut's "new / has state" badge). */
  dot?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: I, label, active, size = 18, box = 'md', caret, dot, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx('oe-iconbtn', `oe-iconbtn--${box}`, active && 'is-active', className)}
      {...rest}
    >
      <I size={size} />
      {caret ? <span className="oe-iconbtn__caret" aria-hidden /> : null}
      {dot ? <span className="oe-iconbtn__dot" aria-hidden /> : null}
    </button>
  );
});

/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = cyan filled (Export), secondary = raised grey (Share/Import), ghost = text only. */
  variant?: ButtonVariant;
  /** `sm` = 24px tall, `md` = 28px (default), `lg` = 34px. */
  size?: 'sm' | 'md' | 'lg';
  /** Optional leading icon. */
  icon?: IconLike;
  /** Full-width block button. */
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: I, block, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('oe-btn', `oe-btn--${variant}`, `oe-btn--${size}`, block && 'oe-btn--block', className)}
      {...rest}
    >
      {I ? <I size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ */

/** Thin vertical separator between toolbar groups (as in CapCut's timeline toolbar). */
export function ToolbarDivider({ className }: { className?: string }) {
  return <span role="separator" aria-orientation="vertical" className={cx('oe-divider', className)} />;
}

/** Horizontal row for IconButtons with CapCut toolbar spacing. */
export function Toolbar({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} className={cx('oe-toolbar', className)}>
      {children}
    </div>
  );
}
