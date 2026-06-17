#!/usr/bin/env python3
"""Assemble narrated clips + audio into the 3-minute explainer MP4.

For each scene (manifest order): take the final `dur` seconds of its recorded
clip (the motion tail — the app-load head is dropped), normalise to 1080p/30fps,
mux its narration MP3, then concatenate all segments. Hard cuts between scenes.

Out: extras/out/digipin-explainer.mp4
Usage: python3 extras/build-narrated.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CLIPS = os.path.join(OUT, "clips")
NARR = os.path.join(OUT, "narration")
SEG = os.path.join(OUT, "_seg")
os.makedirs(SEG, exist_ok=True)
W, H, FPS = 1920, 1080, 30


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2500:])
        raise SystemExit("ffmpeg failed: " + " ".join(cmd[:8]) + " …")


def main():
    manifest = json.load(open(os.path.join(NARR, "manifest.json")))
    segs = []
    for sc in manifest:
        sid, dur = sc["id"], float(sc["dur"])
        clip = os.path.join(CLIPS, f"{sid}.webm")
        mp3 = os.path.join(NARR, f"{sid}.mp3")
        if not os.path.exists(clip):
            print("MISSING clip", sid); continue
        seg = os.path.join(SEG, f"{sid}.mp4")
        vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
              f"crop={W}:{H},setsar=1,fps={FPS},format=yuv420p")
        # Final `dur` seconds of the clip (motion tail) + the narration audio.
        run(["ffmpeg", "-y", "-sseof", f"-{dur:.3f}", "-i", clip, "-i", mp3,
             "-map", "0:v:0", "-map", "1:a:0", "-t", f"{dur:.3f}",
             "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-af", "apad",
             "-shortest", "-movflags", "+faststart", seg])
        segs.append(seg)
        print("seg", sid, f"{dur:.1f}s")

    listf = os.path.join(SEG, "list.txt")
    with open(listf, "w") as f:
        for s in segs:
            f.write(f"file '{s}'\n")
    out = os.path.join(OUT, "digipin-explainer.mp4")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out])
    total = sum(float(s["dur"]) for s in manifest)
    print(f"DONE: {out}  (~{total:.0f}s, {len(segs)} scenes)")


if __name__ == "__main__":
    main()
