"""Render the shared app icon into the iPhone icon catalog on macOS."""
import json
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[2]
source = root / "mobile/assets/icon-1024.png"
if not source.exists():
    raise SystemExit("Shared app icon is missing")
catalog = Path(__file__).parent / "VoiceRooms/Assets.xcassets/AppIcon.appiconset"
catalog.mkdir(parents=True, exist_ok=True)
images = []
for points, scales in [(20,[2,3]),(29,[2,3]),(40,[2,3]),(60,[2,3])]:
    for scale in scales:
        pixels = points * scale
        name = f"icon-{points}@{scale}x.png"
        subprocess.run(["sips","-z",str(pixels),str(pixels),str(source),"--out",str(catalog/name)],check=True,stdout=subprocess.DEVNULL)
        images.append({"idiom":"iphone","size":f"{points}x{points}","scale":f"{scale}x","filename":name})
import shutil
shutil.copy2(source,catalog/"icon-1024.png")
images.append({"idiom":"ios-marketing","size":"1024x1024","scale":"1x","filename":"icon-1024.png"})
(catalog/"Contents.json").write_text(json.dumps({"images":images,"info":{"author":"xcode","version":1}},indent=2))
