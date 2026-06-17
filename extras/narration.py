#!/usr/bin/env python3
"""Generate the explainer narration: one MP3 per scene + a duration manifest.

Voice: gTTS, Indian English (tld co.in). Output: extras/out/narration/<id>.mp3
and extras/out/narration/manifest.json  ([{id, text, dur, theme, motion}]).

Usage:  python3 extras/narration.py
"""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
NARR = os.path.join(HERE, "out", "narration")
os.makedirs(NARR, exist_ok=True)

# Each scene: id, theme, a motion key the recorder understands, and narration.
SCENES = [
    ("00-digipin", "light", "card:DIGIPIN — India's Digital Address",
     "DIGIPIN is India's official digital address — an open, offline addressing "
     "grid launched by the Department of Posts, Ministry of Communications, with "
     "I-I-T Hyderabad and ISRO. It turns any location in the country into a "
     "precise, four-metre, ten-character code. DigiPin Urban Intelligence builds "
     "a decision-making layer on top of that national grid."),
    ("01-intro", "light", "zoomin",
     "Most maps show you where things are. DigiPin shows you what a place is "
     "actually like — to live in, to work in, and to invest in. Let's take a "
     "tour of one city: Indore."),
    ("02-grid", "light", "pan",
     "It starts with the grid. DigiPin divides the entire city into small, "
     "uniquely addressable cells, each just a few hundred metres across. Every "
     "cell has a short code, so instead of a vague address, you get a precise, "
     "shareable location — and a container for data."),
    ("03-livability", "light", "scores:livability",
     "And here is the data. Every cell is scored from zero to one hundred "
     "across twenty dimensions of urban quality. This is livability. Green "
     "cells are the best places to live — combining safety, green space, "
     "healthcare access, and quiet. Red cells fall short. In one glance, you "
     "read the whole city."),
    ("04-walkability", "light", "scores:walkability",
     "Change the metric, and the city re-colours instantly. Walkability "
     "measures how much you can reach on foot — shops, schools, parks, and "
     "transit. The greener the cell, the more of daily life is within a short "
     "walk."),
    ("05-commercial", "light", "scores:commercial",
     "Commercial activity highlights the busy retail and office cores, and the "
     "quieter residential gaps in between. Whether you are siting a new store "
     "or planning infrastructure, these patterns are the starting point. There "
     "are twenty scores in all — from flood risk to digital readiness."),
    ("05b-floodrisk", "light", "scores:flood_risk",
     "Some scores matter most in a crisis. Flood risk flags the low-lying, "
     "poorly-drained cells most likely to inundate when the monsoon hits — so "
     "you can see vulnerability block by block, before the water ever rises."),
    ("06-buildings3d", "light", "orbit",
     "Now, the third dimension. DigiPin renders real building footprints, "
     "extruded to their true heights, as a clean architectural model of the "
     "city. As the camera orbits, the built form takes shape — every block and "
     "every structure, in genuine three-D."),
    ("06b-heatmap3d", "light", "heatmap",
     "Lift any score into the third dimension. This is a living heat-map of the "
     "city — the taller and redder the column, the more intense the hotspot, "
     "with a legend right on the map. The entire urban landscape, readable in "
     "one glance."),
    ("06c-panel", "light", "panel",
     "Click any single cell to open its full profile — live weather, the "
     "air-quality index, elevation, and over a hundred and sixty real-world "
     "features counted around it: schools, clinics, shops and transit. Every "
     "square, fully understood."),
    ("06d-15min", "light", "walkrings",
     "Is this a fifteen-minute city? DigiPin draws five, ten, and fifteen-minute "
     "walking zones around any point, so you can see at a glance how much of "
     "daily life — shops, schools, clinics, parks — is reachable on foot, the "
     "gold standard of liveable urban design."),
    ("06e-viewshed", "light", "card:Line-of-sight analysis",
     "For terrain and planning, line-of-sight analysis. From any vantage point, "
     "DigiPin uses elevation data to compute exactly what is visible and what is "
     "hidden — useful for towers, signage, safety, and scenic protection."),
    ("06f-roads", "light", "roads",
     "Add the full road network, colour-coded by class — highways, arterials, "
     "and local streets — to read a neighbourhood's connectivity and movement "
     "structure instantly."),
    ("07-themes", "dark", "pan",
     "The entire interface comes in two themes. You have been seeing the calm, "
     "paper-light Aino theme. Switch to the dark control-room theme for "
     "low-light work and presentations. Same data, same maps — a completely "
     "different mood."),
    ("08-darkscores", "dark", "scores:livability",
     "On the dark canvas, the score colours light up against the deep "
     "background, making the patterns even easier to spot."),
    ("08b-hazards", "dark", "hazards",
     "DigiPin is also live. It pulls real-time hazards from India's own "
     "agencies — earthquake bulletins from the National Centre for Seismology "
     "and disaster alerts from the national SACHET system — and places them "
     "directly on the grid, so risk and response share one map."),
    ("09-text2map", "dark", "text2map",
     "But the most powerful feature is the simplest to use. Just ask, in plain "
     "English. Say: a family-friendly area, near good schools, with low flood "
     "risk. DigiPin reads your intent, weighs the right scores, ranks every "
     "cell, and highlights the best matches directly on the map — the number "
     "one pick outlined in coral."),
    ("09b-disha", "dark", "disha",
     "And DISHA, the built-in assistant, lets anyone interrogate a location in "
     "natural language — grounded in that cell's real data, with no technical "
     "skill required."),
    ("09c-roadmap", "dark", "card:On the roadmap",
     "And this is just the pilot. On the roadmap: urban growth forecasting, "
     "heat-island mapping, satellite vegetation and land-use, and ward-level "
     "governance layers — the same national grid, with ever more intelligence."),
    ("10-outro", "dark", "zoomout",
     "DigiPin Urban Intelligence — built on India's own digital address, turning "
     "open data into better decisions, one cell at a time."),
]


def dur(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True)
    return float(out.stdout.strip())


def main():
    from gtts import gTTS
    manifest = []
    total = 0.0
    for sid, theme, motion, text in SCENES:
        mp3 = os.path.join(NARR, f"{sid}.mp3")
        gTTS(text, lang="en", tld="co.in").save(mp3)
        d = dur(mp3)
        total += d
        manifest.append({"id": sid, "theme": theme, "motion": motion,
                         "text": text, "dur": round(d, 3), "file": mp3})
        print(f"{sid:16s} {theme:5s} {motion:18s} {d:5.1f}s")
    with open(os.path.join(NARR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"TOTAL narration: {total:.1f}s  ({total/60:.2f} min), {len(manifest)} scenes")


if __name__ == "__main__":
    main()
