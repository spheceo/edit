# dmgbuild settings for Edit's installer window. Used by scripts/make-dmg.sh, which passes
# -D app=… -D background=… -D icon=…. Layout matches scripts/dmg/background.swift.
import os.path

app = defines["app"]
appname = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
# Named " ": Finder writes names in near-black over the picture, so the background draws "Applications" in white.
symlinks = {" ": "/Applications"}
icon = defines["icon"]
# No hide_extensions: it sets Finder info on Edit.app, which breaks its signature's strict check
# (Finder hides ".app" anyway).

background = defines["background"]
# 400 pt of content plus the title bar.
window_rect = ((200, 140), (640, 428))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
arrange_by = None
icon_size = 112
text_size = 13
icon_locations = {
    appname: (160, 186),
    " ": (480, 186),
}
