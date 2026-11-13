#!/usr/bin/env python3
"""Generates every PNG the plugin needs from hand-written SVG shapes (via rsvg-convert)."""
import os
import subprocess
import sys
import tempfile

ROOT = sys.argv[1]

# Shapes are drawn in a 64x64 box with stroke-based line art.
SHAPES = {
    "speaker": '<path d="M9 25h11l15-12v38L20 39H9z" fill="{c}" stroke="{c}" stroke-width="3" stroke-linejoin="round"/>'
               '<path d="M43 23a13 13 0 0 1 0 18" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'
               '<path d="M50 14a25 25 0 0 1 0 36" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>',
    "headphones": '<path d="M11 40v-8a21 21 0 0 1 42 0v8" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'
                  '<rect x="7" y="35" width="13" height="20" rx="5" fill="{c}"/>'
                  '<rect x="44" y="35" width="13" height="20" rx="5" fill="{c}"/>',
    "monitor": '<rect x="7" y="11" width="50" height="32" rx="4" fill="none" stroke="{c}" stroke-width="5"/>'
               '<path d="M32 43v9M20 54h24" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>',
    "mic": '<rect x="23" y="6" width="18" height="32" rx="9" fill="{c}"/>'
           '<path d="M14 29a18 18 0 0 0 36 0M32 47v9M22 58h20" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>',
    "unset": '<rect x="10" y="10" width="44" height="44" rx="9" fill="none" stroke="{c}" stroke-width="4" stroke-dasharray="7 6"/>'
             '<path d="M32 22v20M22 32h20" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>',
    "error": '<path d="M32 9L58 54H6z" fill="none" stroke="{c}" stroke-width="5" stroke-linejoin="round"/>'
             '<path d="M32 25v14" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'
             '<circle cx="32" cy="46.5" r="3" fill="{c}"/>',
    "switch": '<path d="M8 22h40M40 12l10 10-10 10" fill="none" stroke="{c}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'
              '<path d="M56 42H16M24 32L14 42l10 10" fill="none" stroke="{c}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
}
SLASH = '<path d="M11 8L53 57" fill="none" stroke="{bg}" stroke-width="13" stroke-linecap="round"/>' \
        '<path d="M11 8L53 57" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'

GRAY = "#7b8494"
COLORS = {"speaker": "#2dd4bf", "headphones": "#a78bfa", "monitor": "#fbbf24", "mic": "#4ade80"}
BACKGROUNDS = {"speaker": "#0c2b29", "headphones": "#241c40", "monitor": "#33260a", "mic": "#0e2e1a"}
DARK = "#16181d"


def key(shape, color, bg, cy, extra=""):
    """A 144x144 key image; the 64-box drawing is scaled 1.25x and centred at (72, cy)."""
    scale = 1.25
    tx, ty = 72 - 32 * scale, cy - 32 * scale
    body = SHAPES[shape].format(c=color) + extra.format(c=color, bg=bg)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
            f'<rect width="144" height="144" fill="{bg}"/>'
            f'<g transform="translate({tx} {ty}) scale({scale})">{body}</g></svg>')


def glyph(shape, color="#FFFFFF", extra=""):
    body = SHAPES[shape].format(c=color) + extra
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">{body}</svg>'


def render(svg, path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg)
        tmp = f.name
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", path, tmp], check=True)
    os.unlink(tmp)


def pair(svg, base, size):
    render(svg, base + ".png", size)
    render(svg, base + "@2x.png", size * 2)


keys = os.path.join(ROOT, "imgs", "keys")
# Switch keys carry a title along the bottom, so the drawing sits a little high.
for name in ("speaker", "headphones", "monitor", "mic"):
    pair(key(name, COLORS[name], BACKGROUNDS[name], 54), os.path.join(keys, f"{name}-on"), 72)
    pair(key(name, GRAY, DARK, 54), os.path.join(keys, f"{name}-off"), 72)
pair(key("unset", GRAY, DARK, 54), os.path.join(keys, "unset"), 72)
pair(key("error", "#f87171", "#2e1212", 54), os.path.join(keys, "error"), 72)
# Mic-mute keys have no title: centred drawing.
pair(key("mic", COLORS["mic"], BACKGROUNDS["mic"], 72), os.path.join(keys, "micstate-live"), 72)
pair(key("mic", "#f87171", "#2e1212", 72, SLASH), os.path.join(keys, "micstate-muted"), 72)

actions = os.path.join(ROOT, "imgs", "actions")
pair(glyph("switch"), os.path.join(actions, "switch"), 20)
pair(glyph("mic"), os.path.join(actions, "micmute"), 20)

plugin = os.path.join(ROOT, "imgs", "plugin")
pair(glyph("speaker"), os.path.join(plugin, "category"), 28)
icon = ('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
        '<rect width="256" height="256" rx="48" fill="#0c2b29"/>'
        '<g transform="translate(48 48) scale(2.5)">' + SHAPES["speaker"].format(c="#2dd4bf") + '</g></svg>')
pair(icon, os.path.join(plugin, "icon"), 256)
print("icons written")
