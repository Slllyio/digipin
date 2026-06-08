# extras/ — demo & presentation tooling

These files are **not part of the DigiPin PWA**. They generate the
walkthrough video and slide deck used to demo the product. Nothing in
`index.html` / `js/` depends on anything here, and the app runs without it.

| File | What |
|---|---|
| `record-video.mjs` | Playwright script that drives the live app and records a `.webm` walkthrough |
| `build-final-video.py` | Stitches the recording + narration audio into the final MP4 |
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

> A future cleanup could move this whole directory into its own repo; it's
> kept here for now so the demo assets travel with the code.
