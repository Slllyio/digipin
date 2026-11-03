"""Render a triage result as a JSON artifact and a human Markdown brief."""
from __future__ import annotations

_HAZARD_ICON = {
    "flood": "🌊", "cyclone": "🌀", "earthquake": "⊙", "fire": "🔥",
    "storm": "⛈️", "heat": "🌡️", "air": "😷", "landslide": "⛰️",
    "drought": "🏜️", "other": "⚠️",
}


def _band(p: float) -> str:
    return "CRITICAL" if p >= 60 else "HIGH" if p >= 40 else "MODERATE" if p >= 20 else "LOW"


def to_json(result: dict, generated_at: str = "") -> dict:
    """The result plus a generated_at stamp — the shape written to latest.json."""
    return {"generated_at": generated_at, **result}


def to_markdown(result: dict, generated_at: str = "", top: int = 10) -> str:
    """A situational brief: exposure header + a ranked hazard table."""
    region = result.get("region", "?")
    alerts = result.get("alerts", [])
    ex = result.get("region_exposure", {})

    lines = [f"# Alert Triage — {region}", ""]
    if generated_at:
        lines.append(f"_Generated {generated_at}_")
    lines.append(f"_{result.get('matched_total', 0)} of {result.get('event_total', 0)} active hazards touch this region._")
    lines.append(
        f"_Region exposure: population index p90 = {ex.get('pop_p90', '?')}, "
        f"flood-risk p90 = {ex.get('flood_p90', '?')} over {ex.get('cell_count', '?')} cells._"
    )
    lines.append("")

    if not alerts:
        lines.append("**No active hazards correlate with this region right now.**")
        return "\n".join(lines)

    lines.append("| # | Priority | Hazard | Severity | Matched | Headline |")
    lines.append("|---|----------|--------|----------|---------|----------|")
    for i, a in enumerate(alerts[:top], 1):
        icon = _HAZARD_ICON.get(a["hazard"], "⚠️")
        head = str(a.get("headline", "")).replace("|", "/")[:90]
        lines.append(
            f"| {i} | **{a['priority']}** {_band(a['priority'])} | {icon} {a['hazard']} | "
            f"{a.get('severity_label', '')} | {a['matched_by']} | {head} |"
        )
    if len(alerts) > top:
        lines.append("")
        lines.append(f"_…and {len(alerts) - top} more lower-priority alerts (see latest.json)._")
    lines.append("")
    lines.append("_Priority = severity × hazard-relevance × population-exposure. Advisory only — not an actuation._")
    return "\n".join(lines)
