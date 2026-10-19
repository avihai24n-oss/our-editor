/** Segmented sub-tabs (Basic | Mask …): dark track, raised grey active pill. */
export interface SegItem<T extends string> {
  id: T;
  label: string;
  disabled?: boolean;
  title?: string;
  /** Small cyan dot after the label (e.g. "an animation is applied in this slot"). */
  dot?: boolean;
}

export function SegmentedTabs<T extends string>(props: { items: SegItem<T>[]; value: T; onChange: (id: T) => void; label?: string }) {
  return (
    <div className="seg iseg" role="tablist" aria-label={props.label}>
      {props.items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={props.value === it.id}
          disabled={it.disabled}
          title={it.title ?? (it.disabled ? `${it.label} — coming soon` : it.label)}
          className={`seg__item${props.value === it.id ? ' is-active' : ''}`}
          onClick={() => props.onChange(it.id)}
        >
          {it.label}
          {it.dot && <span className="seg__dot" aria-label="applied" />}
        </button>
      ))}
    </div>
  );
}
