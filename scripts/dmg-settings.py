# dmgbuild settings for the OxoFlow install window (used by scripts/build-mac.sh --dmg).
# Positions match assets/dmg-background.png (660x400): the app on the left of
# the arrow, the Applications folder on the right, both on the mid-grey card.
import os.path

app = defines["app"]  # noqa: F821 (injected by dmgbuild -D)
appname = os.path.basename(app)

format = "ULMO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines["volicon"]  # noqa: F821
background = defines["background"]  # noqa: F821

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
# Taller than the 400 px background: the title bar takes ~32 px, and Finder may
# add its path/status bars if the user has them on everywhere.
window_rect = ((200, 140), (660, 436))
default_view = "icon-view"
show_icon_preview = False
arrange_by = None
icon_size = 112
text_size = 13
label_pos = "bottom"
icon_locations = {appname: (180, 205), "Applications": (480, 205)}
