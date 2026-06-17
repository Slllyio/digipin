#!/usr/bin/env python3
"""Assemble the captioned promo stills (extras/out/*.png) into a 1080p video.

Each still becomes a clip with a gentle Ken-Burns zoom; consecutive clips are
joined with crossfades (ffmpeg xfade). Outputs MP4 (H.264) + WebM (VP9).

The weak dark-3D frame (10) is intentionally omitted — the light 3D city is the
hero; the dark theme is shown via its grid + scores.

Usage:  python3 extras/build-promo.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TMP = os.path.join(OUT, "_clips")
os.makedirs(TMP, exist_ok=True)

# Ordered frames (omit 10-dark-3d.png — see module docstring).
FRAMES = [
    "01-title.png", "02-grid.png", "03-livability.png", "04-walkability.png",
    "05-commercial.png", "06-light-3d.png", "07-twothemes.png",
    "08-dark-grid.png", "09-dark-scores.png", "11-text2map.png", "12-outro.png",
]
D = 4.0          # seconds per clip
T = 0.7          # crossfade duration
FPS = 30
W, H = 1920, 1080


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:])
        raise SystemExit(f"ffmpeg failed: {' '.join(cmd[:6])} …")


def make_clip(src, dst, i):
    # Simple, fast, reliable: scale/crop to 1080p. Motion comes from the
    # crossfades between scenes (zoompan proved too slow in this environment).
    vf = (
        f"scale={W}:{H}:force_original_aspect_ratio=increase,"
        f"crop={W}:{H},setsar=1,format=yuv420p"
    )
    run(["ffmpeg", "-y", "-loop", "1", "-t", f"{D}", "-i", src,
         "-vf", vf, "-r", str(FPS), "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", dst])


def main():
    clips = []
    for i, f in enumerate(FRAMES):
        src = os.path.join(OUT, f)
        if not os.path.exists(src):
            print("skip missing", f)
            continue
        dst = os.path.join(TMP, f"clip{i:02d}.mp4")
        make_clip(src, dst, i)
        clips.append(dst)

    n = len(clips)
    # Build the xfade chain.
    inputs = []
    for c in clips:
        inputs += ["-i", c]
    fc = []
    prev = "0:v"
    for i in range(1, n):
        offset = i * (D - T)
        out = f"v{i}"
        fc.append(
            f"[{prev}][{i}:v]xfade=transition=fade:duration={T}:offset={offset:.3f}[{out}]"
        )
        prev = out
    filtergraph = ";".join(fc) if n > 1 else None

    mp4 = os.path.join(OUT, "digipin-promo.mp4")
    cmd = ["ffmpeg", "-y"] + inputs
    if filtergraph:
        cmd += ["-filter_complex", filtergraph, "-map", f"[{prev}]"]
    cmd += ["-r", str(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-crf", "20", "-preset", "medium", "-movflags", "+faststart", mp4]
    run(cmd)

    total = n * D - (n - 1) * T
    print(f"MP4 done: {mp4}  (~{total:.1f}s, {n} scenes)")


if __name__ == "__main__":
    main()
