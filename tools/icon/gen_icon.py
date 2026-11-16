# Génère l'icône « verre » de l'app, même style que Sport et Budget (dalle pleine page : l'iPhone découpe
# lui-même les coins arrondis ; reflets irisés aux coins ; symbole blanc avec halo rouge/bleu décalé).
# Usage : python3 tools/icon/gen_icon.py clap > icone.html   (ou ticket), puis capture 1024x1024 de #ic.
import sys

glyph_name = sys.argv[1] if len(sys.argv) > 1 else "clap"
R = 230  # rayon proche de la découpe iOS (~22,4 %)


def ring(color, inset, width, blur, op=1.0):
    x = inset
    w = 1024 - 2 * inset
    return (f'<rect x="{x}" y="{x}" width="{w}" height="{w}" rx="{max(R - inset, 40)}" fill="none" stroke="{color}" '
            f'stroke-width="{width}" stroke-opacity="{op}" filter="url(#{blur})"/>')


corner_tr = (ring("#ff5a1f", 10, 16, "b6", .9) + ring("#ff2f4a", 16, 22, "b14", .6) + ring("#ffffff", 30, 26, "b6", .95)
             + ring("#2b5bff", 54, 38, "b14", .95))
corner_bl = (ring("#ff5a1f", 10, 14, "b6", .85) + ring("#ff2f4a", 16, 20, "b14", .55) + ring("#ffffff", 30, 22, "b6", .9)
             + ring("#1fc8ff", 52, 36, "b14", .95))

# Symboles (dessinés en blanc ; les « trous » sont faits par un masque pour rester nets).
STRIPES_ARM = "".join(f'<polygon points="{x},366 {x+62},366 {x+14},446 {x-48},446" fill="#000"/>' for x in (330, 450, 570, 690))
STRIPES_BAND = "".join(f'<polygon points="{x},468 {x+62},468 {x+14},548 {x-48},548" fill="#000"/>' for x in (330, 450, 570, 690))
GLYPHS = {
    # Clap : bras incliné (articulé à gauche) + corps, rayures découpées.
    "clap": f'''
      <mask id="cut"><rect width="1024" height="1024" fill="#fff"/>
        <g transform="rotate(-14 262 446)">{STRIPES_ARM}</g>{STRIPES_BAND}
        <rect x="262" y="548" width="500" height="14" fill="#000"/></mask>
      <g mask="url(#cut)">
        <rect x="262" y="366" width="500" height="80" rx="22" transform="rotate(-14 262 446)"/>
        <rect x="262" y="468" width="500" height="300" rx="44"/>
      </g>''',
    # Ticket : rectangle à encoches rondes + pointillés.
    "ticket": (
        '<mask id="cut"><rect width="1024" height="1024" fill="#fff"/>'
        '<circle cx="232" cy="512" r="52" fill="#000"/><circle cx="792" cy="512" r="52" fill="#000"/>'
        + "".join(f'<rect x="602" y="{y}" width="20" height="30" rx="10" fill="#000"/>' for y in range(372, 660, 52))
        + '</mask><g mask="url(#cut)" transform="rotate(-12 512 512)"><rect x="232" y="340" width="560" height="344" rx="46"/></g>'),
}
g = GLYPHS[glyph_name]
print(f'''<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;background:#000}}svg{{display:block}}</style></head><body>
<svg id="ic" width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<defs>
<radialGradient id="bg" cx="45%" cy="40%" r="80%"><stop offset="0" stop-color="#1b1e26"/><stop offset=".65" stop-color="#0b0c10"/><stop offset="1" stop-color="#050608"/></radialGradient>
<linearGradient id="glyph" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#dde5f3"/></linearGradient>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".35" stop-color="#fff" stop-opacity=".12"/><stop offset=".7" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity=".45"/></linearGradient>
<filter id="b6" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7"/></filter>
<filter id="b14" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="16"/></filter>
<filter id="b40" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="45"/></filter>
<mask id="mTR"><rect width="1024" height="1024" fill="#000"/><circle cx="1010" cy="10" r="470" fill="#fff" filter="url(#b40)"/></mask>
<mask id="mBL"><rect width="1024" height="1024" fill="#000"/><circle cx="10" cy="1010" r="450" fill="#fff" filter="url(#b40)"/></mask>
<symbol id="sym" viewBox="0 0 1024 1024">{g}</symbol>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<g mask="url(#mTR)">{corner_tr}</g>
<g mask="url(#mBL)">{corner_bl}</g>
<rect x="6" y="6" width="1012" height="1012" rx="{R - 6}" fill="none" stroke="url(#rim)" stroke-width="6"/>
<rect x="26" y="26" width="972" height="972" rx="{R - 24}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>
<use href="#sym" x="-14" y="5" width="1024" height="1024" fill="#ff3d2e" opacity=".5" filter="url(#b14)"/>
<use href="#sym" x="14" y="-5" width="1024" height="1024" fill="#2b7bff" opacity=".6" filter="url(#b14)"/>
<use href="#sym" width="1024" height="1024" fill="url(#glyph)"/>
<path d="M200 40 Q512 10 824 40" stroke="#fff" stroke-opacity=".3" stroke-width="5" fill="none" filter="url(#b6)"/>
</svg></body></html>''')
