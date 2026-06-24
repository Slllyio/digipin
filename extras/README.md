# extras/ — demo & presentation tooling

These files are **not part of the DigiPin PWA**. They generate the
walkthrough video and slide deck used to demo the product. Nothing in
`index.html` / `js/` depends on anything here, and the app runs without it.

| File | What |
|---|---|
| `record-video.mjs` | Playwright script that drives the live app and records a `.webm` walkthrough |
| `promo-clips.mjs` | Records one short `.webm` per scene into `out/clips/` |
| `promo-stills.mjs` | Captures deterministic 1080p still frames into `out/*.png` |
| `build-promo.py` | Assembles the still frames into a crossfaded promo MP4 |
| `narration.py` | Synthesises the per-scene narration with a **humanised neural voice** (edge-tts, Indian English) → `out/narration/` + `manifest.json` |
| `make_bgm.py` | Renders a **royalty-free ambient music bed** from scratch with ffmpeg |
| `build-narrated.py` | Assembles the scene clips + narration into the explainer MP4, mixing the music bed underneath with sidechain ducking |
| `build-final-video.py` | Alternative builder: stitches a single recording + narration audio into the final MP4 |
| `generate-ppt.py` | Generates the PowerPoint deck |
| `presentation.html` | Standalone slide/video viewer (embeds the generated video) |
| `demo-recorder.html` | In-browser demo recorder helper |
| `VIDEO_SCRIPT.md` | The narration script / shot list |

## Running

All of these are **cwd-relative — run them from the repo root**, not from
inside `extras/`, so the `video-output/` directory and the served app
resolve correctly:

```sh
# from the repo root:
python serve.py &                 # serve the app on :5500
node extras/record-video.mjs      # writes video-output/*.webm
python extras/build-final-video.py
python extras/generate-ppt.py
```

### Narrated explainer (humanised voice + music)

The scene-based explainer adds a neural voiceover and a ducked music bed:

```sh
pip install edge-tts gTTS          # edge-tts = neural voice; gTTS = offline fallback
node extras/promo-clips.mjs        # writes extras/out/clips/*.webm
python3 extras/narration.py        # neural narration → extras/out/narration/
python3 extras/build-narrated.py   # → extras/out/digipin-explainer.mp4 (voice + music)
```

Options: `narration.py --voice en-IN-NeerjaNeural` (female) or `--gtts` (force
fallback); `build-narrated.py --music track.mp3` to supply your own bed,
`--no-music` to drop it, or `--music-volume 0.18` to taste. With no `--music`,
`make_bgm.py` synthesises the ambient bed automatically.

> A future cleanup could move this whole directory into its own repo; it's
> kept here for now so the demo assets travel with the code.
