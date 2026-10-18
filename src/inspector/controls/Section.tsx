/**
 * Inspector section (CapCut anatomy): [☑] Title ▴ ……… ↺ ‹◇›
 * Optional enable checkbox, collapse caret (remembered per `id`), reset, disabled keyframe.
 */
import { useState, type ReactNode } from 'react';
import { readPref, writePref } from '../../panels/prefs';
import { Icon } from '../../ui/Icon';
import { KeyframeButton } from './KeyframeButton';

export function Section(props: {
  /** Stable id for remembering collapse state. */
  id: string;
  title: string;
  children?: ReactNode;
  checked?: boolean;
  onCheck?: (on: boolean) => void;
  onReset?: () => void;
  resetDisabled?: boolean;
  keyframe?: boolean;
  /** Small dimmed note after the title. */
  note?: string;
}) {
  const key = `insp.collapsed.${props.id}`;
  const [open, setOpenState] = useState(() => !readPref(key, false));
  const setOpen = (o: boolean) => {
    setOpenState(o);
    writePref(key, !o);
  };
  const dim = props.onCheck && !props.checked;
  return (
    <section className={`isec${dim ? ' is-off' : ''}`} data-testid={`section-${props.id}`}>
      <header className="isec__head">
        {props.onCheck && (
          <input
            type="checkbox"
            className="checkbox"
            checked={!!props.checked}
            onChange={(e) => props.onCheck!(e.target.checked)}
            aria-label={`Enable ${props.title}`}
          />
        )}
        <button className="isec__title" onClick={() => setOpen(!open)} aria-expanded={open}>
          {props.title}
          <Icon name={open ? 'caret-up' : 'caret-down'} size={10} />
        </button>
        {props.note && <span className="isec__note">{props.note}</span>}
        <span className="isec__spacer" />
        {props.onReset && (
          <button className="icon-btn isec__reset" title="Reset" aria-label={`Reset ${props.title}`} disabled={props.resetDisabled} onClick={props.onReset}>
            <Icon name="reset" size={14} />
          </button>
        )}
        {props.keyframe && <KeyframeButton />}
      </header>
      {open && props.children && <div className="isec__body">{props.children}</div>}
    </section>
  );
}

/** Small grey group label inside a section ("Color", "Lightness" …). */
export const GroupLabel = (props: { children: ReactNode }) => <div className="igroup">{props.children}</div>;

/** Plain label + control row (selects, colour inputs). */
export function FieldRow(props: { label: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`frow${props.disabled ? ' is-disabled' : ''}`}>
      <span className="frow__label">{props.label}</span>
      <div className="frow__ctl">{props.children}</div>
    </div>
  );
}
