# SPDX-License-Identifier: GPL-3.0-only
"""Original optical voxel studies, rendered at 3x then downsampled for NSIS."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "installer" / "windows" / "assets"
OUT.mkdir(parents=True, exist_ok=True)


def scene(size, warm=False):
    w, h = size
    scale = 3
    W, H = w*scale, h*scale
    image = Image.new("RGB", (W,H))
    px=image.load()
    for y in range(H):
        for x in range(W):
            cold=math.exp(-((x/W-.68)**2/.23+(y/H-.27)**2/.13))
            amber=math.exp(-((x/W-.25)**2/.18+(y/H-.85)**2/.12))
            px[x,y]=(int(19+25*cold+23*amber),int(22+26*cold+13*amber),int(29+43*cold+8*amber))
    image=image.convert("RGBA")
    draw=ImageDraw.Draw(image)
    cx,cy=W*.5,H*.47
    r=min(W*.43,H*.36)
    glow=Image.new("RGBA", image.size)
    gd=ImageDraw.Draw(glow)
    for rad,alpha in [(r,95),(r*.92,40),(r*1.04,25)]:
        gd.arc((cx-rad,cy-rad,cx+rad,cy+rad),205,345,fill=(155,192,238,alpha),width=2*scale)
        gd.arc((cx-rad,cy-rad,cx+rad,cy+rad),18,162,fill=(222,186,151,alpha),width=scale)
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(5*scale)))
    image.alpha_composite(glow)
    draw=ImageDraw.Draw(image)
    # Perspective measurement grid resolves into a floating voxel terrarium.
    unit=min(W/20,H/24)
    ox,oy=W*.5,H*.56
    def point(x,y,z=0): return (ox+(x-y)*unit,oy+(x+y)*unit*.48-z*unit)
    def block(x,y,z,top,left,right):
        a,b,c,d=point(x,y,z),point(x+1,y,z),point(x+1,y+1,z),point(x,y+1,z)
        bb,cc,dd=point(x+1,y,z-1),point(x+1,y+1,z-1),point(x,y+1,z-1)
        draw.polygon([d,c,cc,dd],fill=left)
        draw.polygon([b,c,cc,bb],fill=right)
        draw.polygon([a,b,c,d],fill=top)
    for i in range(-7,8):
        draw.line([point(i,-6,-2.3),point(i,7,-2.3)],fill=(110,130,162,28),width=1)
        draw.line([point(-7,i,-2.3),point(7,i,-2.3)],fill=(110,130,162,28),width=1)
    shadow=Image.new("RGBA",image.size)
    sd=ImageDraw.Draw(shadow);sd.ellipse((W*.18,H*.64,W*.85,H*.78),fill=(0,0,0,130))
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8*scale)));draw=ImageDraw.Draw(image)
    for diagonal in range(-6,7):
        for x in range(-3,4):
            y=diagonal-x
            if not -3<=y<=3: continue
            stream=(y==0 or y==1) and x>-2
            top=(105+x*3,135+y*2,130) if stream else (115+x*3,126+y*3,105)
            for z in [-1,0]:block(x,y,z,top,(48+x*2,53,58),(68,70+y*2,75))
            if stream: block(x,y,.06,(112,174,190),(61,111,130),(88,146,160))
    for tx,ty,tz in [(-2,-2,2.9),(1,-2,2.3),(2,3,2.0),(-3,2,1.8)]:
        block(tx,ty,.7,(98,92,78),(52,50,49),(82,73,61))
        for z in [1.5,2.2]:block(tx,ty,z,(138,151,121),(77,101,87),(106,128,101))
    # A precise interrupted lens rim; dotted arc is a bounded form, no fake progress.
    for i in range(38):
        a=math.radians(20+i*3.7)
        x=cx+math.cos(a)*r*1.11;y=cy+math.sin(a)*r*1.11
        draw.ellipse((x-scale*.6,y-scale*.6,x+scale*.6,y+scale*.6),fill=(192,204,208,145))
    for x in [W*.12,W*.88]:
        draw.line((x,H*.15,x+W*.045,H*.15),fill=(191,198,201,130),width=scale)
        draw.line((x,H*.15,x,H*.15+W*.045),fill=(191,198,201,130),width=scale)
    draw.line((W*.13,H*.87,W*.87,H*.87),fill=(150,160,172,60),width=scale)
    for i in range(7):
        x=W*.13+i*W*.1233
        draw.line((x,H*.87,x,H*.87+scale*(6 if i%3==0 else 3)),fill=(178,187,196,100),width=scale)
    return image.convert("RGB").resize(size,Image.Resampling.LANCZOS)


def icon(size, warm=False):
    im=Image.new("RGBA",(size,size),(22,25,31,255));d=ImageDraw.Draw(im)
    c=size/2;r=size*.31
    a=(c,c-r);b=(c+r,c-r*.5);cc=(c+r,c+r*.5);e=(c,c+r);f=(c-r,c+r*.5);g=(c-r,c-r*.5)
    d.polygon([a,b,(c,c),g],fill=(193,205,214))
    d.polygon([g,(c,c),e,f],fill=(91,116,132))
    d.polygon([(c,c),b,cc,e],fill=(199,173,139) if warm else (168,196,135))
    return im


def save_assets():
    scene((164,314)).save(OUT/'sidebar.bmp')
    scene((240,260)).save(OUT/'scene.bmp')
    header=Image.new('RGB',(150,57),(245,243,238))
    mark=icon(44).convert('RGB');header.paste(mark,(99,6));header.save(OUT/'header.bmp')
    for name,warm in [('installer',False),('uninstaller',True)]:
        icon(256,warm).save(OUT/f'{name}.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    print(f'Original optical terrarium assets written to {OUT}')

if __name__ == '__main__': save_assets()
