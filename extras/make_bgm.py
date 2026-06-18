#!/usr/bin/env python3
"""Generate a royalty-free ambient music bed for the explainer video.

The bed is synthesised from scratch with ffmpeg (layered sine partials of a
bright C-major-add9 chord, gently pulsed and spaced with echo, then softened),
so it carries no licensing strings — safe to ship in the repo. It is meant to
sit quietly *under* the narration, where the ducking in build-narrated.py keeps
it out of the way of speech.

Usage:
  python3 extras/make_bgm.py [seconds] [out.mp3]
  python3 extras/make_bgm.py 360 extras/out/bgm.mp3
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "out", "bgm.mp3")

# C-major add9 voicing (Hz): C3, G3, C4, D4, E4 — calm, optimistic, "product" feel.
CHORD = [
    (130.81, 0.42),   # C3 root drone
    (196.00, 0.26),   # G3
    (261.63, 0.30),   # C4
    (293.66, 0.14),   # D4 (the add9 colour)
    (329.63, 0.20),   # E4
]
FADE = 4.0   # seconds of fade in/out


def generate(out_path=DEFAULT_OUT, seconds=360.0):
    """Render an ambient bed of `seconds` length to `out_path` (mp3)."""
    seconds = float(seconds)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)

    inputs = []
    mix_labels = []
    parts = []
    for i, (freq, vol) in enumerate(CHORD):
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100"]
        parts.append(f"[{i}]volume={vol}[v{i}]")
        mix_labels.append(f"[v{i}]")

    fade_out_start = max(0.0, seconds - FADE)
    chain = (
        f"{''.join(mix_labels)}amix=inputs={len(CHORD)}:normalize=0,"
        # slow amplitude pulse so the pad breathes instead of sitting static
        "tremolo=f=0.10:d=0.35,"
        # chorus detunes/thickens the bare sines into a warm, moving pad
        "chorus=0.6:0.85:55|75:0.5|0.35:0.45|0.4:2|1.5,"
        # two short echoes widen it into an ambient space
        "aecho=0.8:0.7:600|1100:0.4|0.3,"
        # tame the sterile sine harmonics; high-pass clears muddy sub rumble
        "highpass=f=70,lowpass=f=1500,"
        f"atrim=0:{seconds:.3f},"
        f"afade=t=in:st=0:d={FADE},"
        f"afade=t=out:st={fade_out_start:.3f}:d={FADE}[bgm]"
    )
    parts.append(chain)
    filtergraph = ";".join(parts)

    cmd = [
        "ffmpeg", "-y", *inputs,
        "-filter_complex", filtergraph,
        "-map", "[bgm]",
        "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k",
        out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2500:])
        raise SystemExit("ffmpeg failed to render the ambient bed")
    return out_path


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 360.0
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    path = generate(out, seconds)
    print(f"BGM written: {path}  ({seconds:.0f}s)")


if __name__ == "__main__":
    main()
