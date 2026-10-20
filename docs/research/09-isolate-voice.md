# 09 — CapCut "Isolate voice" (clip right-click menu) — 2026-10-20

## What CapCut offers

- **Where:** CapCut desktop, right-click a video or audio clip → **Isolate voice ›** (tagged
  *Free* in the current menu; older builds listed it under Pro). The same feature sits in the Audio
  tab as the *Isolate voice* row (screenshot `docs/capcut-screens/03`), shown with an AI badge.
- **What it does:** an AI source-separation model splits the clip's sound into vocals and
  background. CapCut describes it as a one-click way to "isolate vocals and background music",
  where you choose to **keep the vocals** or **remove them** (keep the background), and claims the
  background keeps its quality ([capcut.com — voice isolator](https://www.capcut.com/resource/voice-isolator),
  [capcut.com — vocal remover](https://capcut.com/tools/vocal-remover)). In practice the submenu has
  two choices, roughly *Isolate vocals* and *Remove vocals*, and the result is applied to the
  clip after a processing pass.
- **Strength:** no strength slider could be confirmed on an official page; we add a 0–100 Strength
  (the inspector row has it; the menu applies 100).
- Third-party listicles say the feature used to be Pro and is now free for members
  ([capcut.com — acapella extractors](https://capcut.com/resource/best-ai-acapella-extractors)).
  The exact submenu labels were not confirmed from an official help page.

## What we built (no AI, runs locally)

Labelled honestly as **"Voice isolation (DSP)"** in the menu and **"Isolate voice · DSP · not AI"**
in Audio › Basic.

| CapCut | Ours |
|---|---|
| Isolate vocals | `mode: 'isolate'` — STFT (N 1024, hop 256, √Hann) Wiener suppression with a decision-directed a-priori SNR; the noise spectrum is learned **offline once per clip** from its quietest 10 % of frames and cached; 100 Hz–8 kHz emphasis (12 dB/oct outside, ≥ −30 dB); gentle −12 dB gate when no speech-band bin stands 10 dB above the noise. |
| Remove vocals / keep background | `mode: 'remove'` — **approximate**: mid/side split per bin, the centre cut by up to −30 dB in 150 Hz–6 kHz; side content, centre bass and air kept. A mono clip gets a speech-band notch. |
| (none) | Strength 0–100: every bin gain is (1 − s) + s · g; 0 = bit-exact pass-through (delayed 1024 samples). |

Limits: it is not source separation — music under speech is only reduced where it sits below the
learned noise floor; a clip with no pauses learns a profile from its quietest speech and will thin
it; the stage delays the clip by 21 ms (preview and export alike, under one frame).
