#!/usr/bin/env python3
"""Assemble narrated clips + audio into the explainer MP4, over a music bed.

For each scene (manifest order): take the final `dur` seconds of its recorded
clip (the motion tail — the app-load head is dropped), normalise to 1080p/30fps,
mux its narration MP3, then concatenate all segments. Hard cuts between scenes.
A royalty-free ambient bed (see make-bgm.py) is finally mixed underneath with
sidechain ducking, so the music automatically dips whenever narration plays.

Out: extras/out/digipin-explainer.mp4
Usage:
  python3 extras/build-narrated.py
  python3 extras/build-narrated.py --music path/to/track.mp3
  python3 extras/build-narrated.py --no-music
  python3 extras/build-narrated.py --music-volume 0.18
"""
import argparse
import json
import os
import subprocess
import sys

import make_bgm

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CLIPS = os.path.join(OUT, "clips")
NARR = os.path.join(OUT, "narration")
SEG = os.path.join(OUT, "_seg")
os.makedirs(SEG, exist_ok=True)
W, H, FPS = 1920, 1080, 30
MUSIC_VOLUME = 0.14   # bed level before ducking (narration sits at 1.0)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2500:])
        raise SystemExit("ffmpeg failed: " + " ".join(cmd[:8]) + " …")


def probe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(r.stdout.strip())


def add_music(narrated, music_path, out_path, volume=MUSIC_VOLUME):
    """Mix `music_path` under `narrated`'s narration with sidechain ducking."""
    total = probe_dur(narrated)
    # [music] loop+trim to length, drop to bed level; duck it by the narration
    # (used as the sidechain key); mix narration (full) with ducked bed.
    fg = (
        f"[1:a]aloop=loop=-1:size=2e+09,atrim=0:{total:.3f},asetpts=N/SR/TB,"
        f"volume={volume}[bed];"
        "[0:a]asplit=2[voice][key];"
        "[bed][key]sidechaincompress=threshold=0.015:ratio=8:attack=20:release=400[duck];"
        "[voice][duck]amix=inputs=2:duration=first:normalize=0,"
        "dynaudnorm=f=250:g=7[aout]"
    )
    run(["ffmpeg", "-y", "-i", narrated, "-i", music_path,
         "-filter_complex", fg, "-map", "0:v", "-map", "[aout]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", out_path])


def main():
    ap = argparse.ArgumentParser(description="Assemble the narrated explainer with a music bed")
    ap.add_argument("--music", default=None, help="background track (mp3/wav); default: auto-generated ambient bed")
    ap.add_argument("--no-music", action="store_true", help="skip the background music")
    ap.add_argument("--music-volume", type=float, default=MUSIC_VOLUME, help=f"bed level before ducking (default {MUSIC_VOLUME})")
    args = ap.parse_args()

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
    if not segs:
        raise SystemExit("No scene segments were produced — check extras/out/clips and extras/out/narration.")
    with open(listf, "w") as f:
        for s in segs:
            f.write(f"file '{s}'\n")
    out = os.path.join(OUT, "digipin-explainer.mp4")
    # Concatenate the narrated segments. With music we render this to an
    # intermediate (narration-only) file, then mix the bed underneath.
    concat_target = out if args.no_music else os.path.join(SEG, "_concat.mp4")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", concat_target])

    if not args.no_music:
        total_s = probe_dur(concat_target)
        music = args.music
        if music:
            if not os.path.exists(music):
                raise SystemExit(f"--music file not found: {music}")
            print(f"music bed: {music}")
        else:
            music = os.path.join(OUT, "bgm.mp3")
            print(f"music bed: generating ambient track ({total_s:.0f}s)…")
            make_bgm.generate(music, total_s + 2)
        add_music(concat_target, music, out, volume=args.music_volume)

    total = sum(float(s["dur"]) for s in manifest)
    music_note = "narration only" if args.no_music else "narration + ducked music bed"
    print(f"DONE: {out}  (~{total:.0f}s, {len(segs)} scenes, {music_note})")


if __name__ == "__main__":
    main()
