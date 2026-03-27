#!/usr/bin/env python3
"""
Generate ClawGuard app icon (1024x1024) for App Store submission.

Uses Pillow to create a shield + lock icon in the VaultClaw brand colors.
Run: pip install Pillow && python scripts/generate-app-icon.py

Output: openharness-swift/ios/App/Assets.xcassets/AppIcon.appiconset/icon_1024.png
"""
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Install Pillow: pip install Pillow")
    sys.exit(1)

SIZE = 1024
OUTPUT_DIR = Path(__file__).parent.parent / "openharness-swift" / "ios" / "App" / "Assets.xcassets" / "AppIcon.appiconset"

def create_icon() -> Image.Image:
    """Create a shield icon with gradient background."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background — deep blue gradient effect (solid for simplicity)
    bg_color = (10, 25, 60)  # Dark navy
    draw.rounded_rectangle([0, 0, SIZE, SIZE], radius=SIZE // 5, fill=bg_color)

    # Shield shape — centered
    cx, cy = SIZE // 2, SIZE // 2 - 20
    sw, sh = 480, 560  # shield width, height

    # Shield path points
    shield_points = [
        (cx, cy - sh // 2),           # top center
        (cx + sw // 2, cy - sh // 3),  # top right
        (cx + sw // 2, cy + sh // 6),  # mid right
        (cx, cy + sh // 2),            # bottom center (point)
        (cx - sw // 2, cy + sh // 6),  # mid left
        (cx - sw // 2, cy - sh // 3),  # top left
    ]

    # Shield fill — blue gradient simulation
    draw.polygon(shield_points, fill=(30, 100, 220), outline=(60, 140, 255))

    # Inner shield (lighter)
    inner_scale = 0.82
    inner_points = [
        (cx + int((px - cx) * inner_scale), cy + int((py - cy) * inner_scale))
        for px, py in shield_points
    ]
    draw.polygon(inner_points, fill=(20, 70, 180))

    # Lock icon in center of shield
    lock_cx, lock_cy = cx, cy + 30
    lock_w, lock_h = 120, 100

    # Lock body
    draw.rounded_rectangle(
        [lock_cx - lock_w // 2, lock_cy - lock_h // 4,
         lock_cx + lock_w // 2, lock_cy + lock_h],
        radius=16,
        fill=(255, 255, 255)
    )

    # Lock shackle (arc)
    shackle_w, shackle_h = 80, 80
    draw.arc(
        [lock_cx - shackle_w // 2, lock_cy - shackle_h - lock_h // 4,
         lock_cx + shackle_w // 2, lock_cy - lock_h // 4 + 10],
        180, 0,
        fill=(255, 255, 255),
        width=16
    )

    # Keyhole
    draw.ellipse(
        [lock_cx - 15, lock_cy + 10, lock_cx + 15, lock_cy + 40],
        fill=(20, 70, 180)
    )
    draw.polygon(
        [(lock_cx - 8, lock_cy + 35), (lock_cx + 8, lock_cy + 35),
         (lock_cx + 4, lock_cy + 60), (lock_cx - 4, lock_cy + 60)],
        fill=(20, 70, 180)
    )

    # "CG" text at bottom
    try:
        font = ImageFont.truetype("/System/Library/Fonts/SFCompact-Bold.otf", 80)
    except (OSError, IOError):
        try:
            font = ImageFont.truetype("arial.ttf", 80)
        except (OSError, IOError):
            font = ImageFont.load_default()

    draw.text((cx, cy + sh // 2 + 50), "CG", fill=(60, 140, 255),
              font=font, anchor="mt")

    return img


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    icon = create_icon()
    output_path = OUTPUT_DIR / "icon_1024.png"
    icon.save(output_path, "PNG")
    print(f"Icon saved to {output_path}")

    # Update Contents.json to reference the icon
    contents = OUTPUT_DIR / "Contents.json"
    contents.write_text("""{
  "images" : [
    {
      "filename" : "icon_1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
""")
    print(f"Contents.json updated at {contents}")
    print("Done! Open the project in Xcode to verify the icon.")


if __name__ == "__main__":
    main()
