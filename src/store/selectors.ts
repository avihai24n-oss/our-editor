/**
 * Selectors. Use with `useEditor(selector)`; for selectors returning new arrays/objects wrap
 * with `useShallow` from 'zustand/react/shallow' to avoid re-render loops.
 */
import { findClip, findTransition, timelineRows, usedAssetIds } from '../model/project';
import { projectDuration } from '../model/time';
import type { Clip, Id, Project, Track, Transition } from '../model/types';
import type { EditorState } from './index';

export const selectProject = (s: EditorState): Project => s.project;
export const selectSettings = (s: EditorState) => s.project.settings;
export const selectDuration = (s: EditorState): number => projectDuration(s.project);
export const selectCanUndo = (s: EditorState): boolean => s.past.length > 0 || (s.txBase !== null && s.txBase !== s.project);
export const selectCanRedo = (s: EditorState): boolean => s.future.length > 0;
export const selectTimelineRows = (s: EditorState): Track[] => timelineRows(s.project);
export const selectAssets = (s: EditorState) => s.project.assets;
export const selectUsedAssetIds = (s: EditorState): Set<Id> => usedAssetIds(s.project);

/** The single selected clip (or null when 0 or many are selected). Drives the inspector. */
export const selectSelectedClip = (s: EditorState): Clip | null => {
  if (s.selection.clipIds.length !== 1) return null;
  return findClip(s.project, s.selection.clipIds[0]!)?.clip ?? null;
};

export const selectSelectedClips = (s: EditorState): Clip[] =>
  s.selection.clipIds.map((id) => findClip(s.project, id)?.clip).filter((c): c is Clip => !!c);

export const selectSelectedTransition = (s: EditorState): Transition | null =>
  s.selection.transitionId ? findTransition(s.project, s.selection.transitionId)?.transition ?? null : null;

export const selectClipById = (id: Id) => (s: EditorState): Clip | null => findClip(s.project, id)?.clip ?? null;
export const selectTrackById = (id: Id) => (s: EditorState): Track | null => s.project.tracks.find((t) => t.id === id) ?? null;
export const selectIsSelected = (id: Id) => (s: EditorState): boolean => s.selection.clipIds.includes(id);
