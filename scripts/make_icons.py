"""Draw the Scrollback icon set (16/32/48/128) and store tiles from one master."""
import sys
from PIL import Image, ImageDraw

S = 1024

def master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg = Image.new("RGBA", (S, S))
    px = bg.load()
    top, bot = (124, 108, 246), (76, 64, 200)
    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(S):
            px[x, y] = c
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=255)
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    # chat bubble
    d.rounded_rectangle((210, 220, 814, 640), radius=120, fill=white)
    d.polygon([(330, 610), (300, 760), (470, 630)], fill=white)
    # stacked message lines inside the bubble
    ink = (88, 76, 214, 255)
    d.rounded_rectangle((300, 330, 724, 380), radius=25, fill=ink)
    d.rounded_rectangle((300, 425, 620, 475), radius=25, fill=ink)
    d.rounded_rectangle((300, 520, 540, 570), radius=25, fill=ink)
    # download arrow bottom right
    d.ellipse((600, 600, 880, 880), fill=(255, 255, 255, 255))
    d.ellipse((622, 622, 858, 858), fill=(46, 196, 132, 255))
    d.rectangle((718, 665, 762, 770), fill=white)
    d.polygon([(670, 750), (810, 750), (740, 825)], fill=white)
    return img

def main(out):
    m = master()
    for n in (16, 32, 48, 128):
        m.resize((n, n), Image.LANCZOS).save(f"{out}/{n}.png")
    m.resize((512, 512), Image.LANCZOS).save(f"{out}/../store/icon-512.png")

if __name__ == "__main__":
    main(sys.argv[1])
