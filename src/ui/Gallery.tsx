/**
 * Dev-only visual check for the UI kit: every icon with its name, at 18px and 24px,
 * plus every IconButton / Button state. Mount it anywhere, e.g. temporarily in App:
 *   import { Gallery } from './ui/Gallery';  ->  <Gallery />
 */
import { useState } from 'react';
import { Icons, iconNames } from './icons';
import { Button, IconButton, Toolbar, ToolbarDivider } from './primitives';

export function Gallery() {
  const [snap, setSnap] = useState(true);
  return (
    <div className="oe-gallery">
      <h2>Icons ({iconNames.length}, aliases included) — 18px</h2>
      <div className="oe-gallery__grid">
        {iconNames.map((name) => {
          const I = Icons[name];
          return (
            <div key={name} className="oe-gallery__cell" title={name}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <I />
                <I size={24} />
              </div>
              <span>{name}</span>
            </div>
          );
        })}
      </div>

      <h2>Timeline toolbar mock</h2>
      <div className="oe-gallery__row">
        <Toolbar label="Timeline tools">
          <IconButton icon={Icons.Plus} label="Add" dot />
          <ToolbarDivider />
          <IconButton icon={Icons.Select} label="Select (A)" caret />
          <ToolbarDivider />
          <IconButton icon={Icons.Undo} label="Undo (Ctrl+Z)" />
          <IconButton icon={Icons.Redo} label="Redo (Ctrl+Shift+Z)" disabled />
          <IconButton icon={Icons.Split} label="Split (Ctrl+B)" />
          <IconButton icon={Icons.DeleteLeft} label="Delete left (Q)" />
          <IconButton icon={Icons.DeleteRight} label="Delete right (W)" />
          <IconButton icon={Icons.Trash} label="Delete" />
          <IconButton icon={Icons.Marker} label="Add marker (M)" />
          <IconButton icon={Icons.Crop} label="Crop" />
          <IconButton icon={Icons.Mirror} label="Mirror" />
          <IconButton icon={Icons.Rotate} label="Rotate" />
          <IconButton icon={Icons.Freeze} label="Freeze frame" />
          <ToolbarDivider />
          <IconButton icon={Icons.Mic} label="Record audio" />
          <IconButton icon={Icons.Magnet} label="Snap (N)" active={snap} onClick={() => setSnap((v) => !v)} />
          <IconButton icon={Icons.Link} label="Linkage" active />
          <IconButton icon={Icons.PreviewAxis} label="Preview axis (S)" />
          <IconButton icon={Icons.ZoomOut} label="Zoom out (Ctrl+-)" />
          <IconButton icon={Icons.ZoomIn} label="Zoom in (Ctrl+=)" />
          <IconButton icon={Icons.ZoomFit} label="Fit timeline (Shift+Z)" />
        </Toolbar>
      </div>

      <h2>Track header mock (sm)</h2>
      <div className="oe-gallery__row">
        <Toolbar label="Track header">
          <IconButton box="sm" size={16} icon={Icons.VideoTrack} label="Video track" />
          <IconButton box="sm" size={16} icon={Icons.Lock} label="Lock track" />
          <IconButton box="sm" size={16} icon={Icons.Eye} label="Hide track" />
          <IconButton box="sm" size={16} icon={Icons.Volume} label="Mute track" />
          <IconButton box="sm" size={16} icon={Icons.More} label="More" />
        </Toolbar>
      </div>

      <h2>Buttons</h2>
      <div className="oe-gallery__row">
        <Button variant="primary" icon={Icons.Export}>Export</Button>
        <Button variant="primary" size="sm">Save as preset</Button>
        <Button variant="primary" disabled>Disabled</Button>
        <Button variant="secondary" icon={Icons.Import}>Import</Button>
        <Button variant="secondary" icon={Icons.Record}>Record</Button>
        <Button variant="secondary" size="lg">Large</Button>
        <Button variant="ghost" icon={Icons.Reset}>Reset</Button>
        <Button variant="ghost" size="sm">Apply to all</Button>
      </div>
    </div>
  );
}

export default Gallery;
